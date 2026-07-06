// Run-Panel (Spec §6.2 + UI-STANDARD §4): ein einziger View mit interner
// Tab-Navigation (Kopf → Tab-Leiste → Content → optionale Statuszeile). Die View hält
// nur zwei orthogonale Zustände — navState (welcher Tab, überlebt Re-Render) und
// runState (aus Orchestrator-Events) — und rendert das von `buildPanelViewModel`
// gelieferte, deklarative ViewModel via createEl. ALLE Entscheidungslogik lebt in der
// puren panel-view-model.ts (node-testbar); dieses Modul trifft keine Entscheidung.
// DOM ausschließlich über createEl/createDiv/createSpan — nie HTML-String-Zuweisung.
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { t } from "../vendor/kit/i18n";
import type { RunEvent } from "../core/ports";
import type { RunStatus } from "../core/types";
import {
  buildPanelViewModel, markAborting, reduceRun,
  type BodyVM, type NavState, type PanelViewModel, type RunState,
  type RunSummary, type StatusLineVM, type SummaryVM,
} from "./panel-view-model";

export const VIEW_TYPE_CREWS = "vault-crews-panel";

export type { RunSummary } from "./panel-view-model";

export interface PanelTeam {
  id: string;
  name: string;
  description: string;
  lastRun: { status: RunStatus; when: number } | null;
}

/** Schmaler Vertrag statt eines main.ts-Imports. main.ts übergibt sein Plugin-Objekt,
 *  das diese Mitglieder implementiert. Alle Aktions-Methoden sind bewusst `void` (kein
 *  Rückkanal in die Laufsteuerung, Spec §6.2); getTeams/getLastRunSummary sind reine
 *  Getter, damit die Render-Seite synchron bleibt. */
export interface PanelHost {
  getTeams(): PanelTeam[];
  runCrew(teamId: string): void;
  abortCurrentRun(): void;
  undoLastRun(): void;
  openLog(): void;
  installExamples(): void;
  getLastRunSummary(): RunSummary | null;
  openCrewLog(teamId: string): void;
}

export class RunPanelView extends ItemView {
  private navState: NavState = "crews";
  private runState: RunState = { kind: "idle" };

  constructor(leaf: WorkspaceLeaf, private readonly host: PanelHost) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_CREWS; }
  getDisplayText(): string { return t("panel.title"); }
  getIcon(): string { return "list-checks"; }

  async onOpen(): Promise<void> {
    this.render();
  }
  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Treibt runState ausschließlich aus Orchestrator-Events (main.ts verdrahtet
   *  RunReporter.emit → handleEvent). Jedes Event rendert vollständig neu (DOM = reine
   *  Funktion des Zustands), analog zu SettingsTab.display(). */
  handleEvent(e: RunEvent): void {
    this.runState = reduceRun(this.runState, e);
    this.render();
  }

  private render(): void {
    const vm = buildPanelViewModel({
      navState: this.navState,
      runState: this.runState,
      teams: this.host.getTeams(),
      latest: this.host.getLastRunSummary(),
      nowMs: Date.now(),
    });
    this.renderViewModel(vm);
  }

  // ── Reine Übersetzung ViewModel → DOM (keine Entscheidungslogik) ────────────

  private renderViewModel(vm: PanelViewModel): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("vault-crews-panel");

    root.createEl("h2", { cls: "vault-crews-title", text: vm.title });

    const tabs = root.createDiv({ cls: "vault-crews-tabs" });
    for (const tab of vm.tabs) {
      const btn = tabs.createEl("button", {
        cls: tab.active ? "vault-crews-tab is-active" : "vault-crews-tab",
        text: tab.label,
      });
      if (!tab.active) btn.addEventListener("click", () => { this.navState = tab.id; this.render(); });
    }

    const content = root.createDiv({ cls: "vault-crews-content" });
    this.renderBody(content, vm.body);

    if (vm.statusLine !== null) this.renderStatusLine(root, vm.statusLine);
  }

  private renderBody(root: HTMLElement, body: BodyVM): void {
    switch (body.kind) {
      case "crewsIdle": {
        if (body.empty) {
          root.createDiv({ cls: "vault-crews-empty", text: body.emptyText });
          const install = root.createEl("button", { cls: "mod-cta", text: body.installLabel });
          install.addEventListener("click", () => { this.host.installExamples(); });
          return;
        }
        const list = root.createDiv({ cls: "vault-crews-team-list" });
        for (const team of body.teams) {
          const row = list.createDiv({ cls: "vault-crews-team-row" });
          row.createDiv({ cls: "vault-crews-team-name", text: team.name });
          row.createDiv({ cls: "vault-crews-team-desc", text: team.description });
          row.createDiv({ cls: "vault-crews-team-status", text: team.statusText });
          const runBtn = row.createEl("button", { cls: "vault-crews-run", text: team.runLabel });
          runBtn.addEventListener("click", () => { this.host.runCrew(team.id); });
        }
        return;
      }
      case "crewsRunning": {
        const list = root.createDiv({ cls: "vault-crews-task-list" });
        for (const line of body.lines) {
          const row = list.createDiv({ cls: "vault-crews-task-row" });
          row.createSpan({ cls: "vault-crews-task-icon", text: line.icon });
          row.createSpan({ cls: "vault-crews-task-label", text: line.label });
        }
        root.createDiv({ cls: "vault-crews-progress", text: body.streamingText });
        // <think> nur als Zähler, aufklappbar, nie aufgedrängt: natives <details> ohne
        // `open`-Attribut ist genau diese Semantik, ganz ohne eigene Toggle-Logik.
        const think = root.createEl("details", { cls: "vault-crews-think" });
        think.createEl("summary", { text: body.thinkingText });
        return;
      }
      case "crewsDone": {
        this.renderSummary(root, body.summary);
        const back = root.createEl("button", { cls: "vault-crews-back", text: body.backLabel });
        back.addEventListener("click", () => { this.runState = { kind: "idle" }; this.render(); });
        return;
      }
      case "history": {
        if (body.empty) {
          root.createDiv({ cls: "vault-crews-empty", text: body.emptyText });
          return;
        }
        if (body.latest !== null) this.renderSummary(root, body.latest);
        if (body.crews.length > 0) {
          const section = root.createDiv({ cls: "vault-crews-section" });
          section.createDiv({ cls: "vault-crews-section-heading", text: body.crewsHeading });
          const list = section.createDiv({ cls: "vault-crews-history-list" });
          for (const crew of body.crews) {
            const row = list.createDiv({ cls: "vault-crews-history-row", text: crew.text });
            row.addEventListener("click", () => { this.host.openCrewLog(crew.teamId); });
          }
        }
        return;
      }
    }
  }

  /** Ergebnis-Karte, geteilt zwischen Crews-Done und Verlauf-jüngster-Lauf (DRY). */
  private renderSummary(root: HTMLElement, s: SummaryVM): void {
    const card = root.createDiv({ cls: "vault-crews-summary" });
    card.createEl("h3", { cls: "vault-crews-summary-heading", text: s.heading });
    if (s.teamName !== null) card.createDiv({ cls: "vault-crews-summary-team", text: s.teamName });

    card.createDiv({ cls: "vault-crews-summary-files", text: s.filesText });
    if (s.files.length > 0) {
      const files = card.createDiv({ cls: "vault-crews-files" });
      for (const path of s.files) {
        // `.internal-link` + `href` = Vault-Pfad: Obsidian löst Klicks global auf.
        files.createEl("a", { cls: "internal-link", text: path, attr: { href: path } });
      }
    }
    card.createDiv({ cls: "vault-crews-summary-duration", text: s.durationText });
    if (s.abortNote !== null) card.createDiv({ cls: "vault-crews-summary-abort", text: s.abortNote });

    const actions = card.createDiv({ cls: "vault-crews-summary-actions" });
    const primary = actions.createEl("button", { cls: "mod-cta", text: s.primaryLabel });
    primary.addEventListener("click", () => { this.host.openLog(); });
    // Undo nur, wenn der Lauf etwas geschrieben hat (Snapshot vorhanden).
    if (s.undoable) {
      const undo = actions.createEl("button", { cls: "vault-crews-undo", text: s.undoLabel });
      undo.addEventListener("click", () => { this.host.undoLastRun(); });
    }

    const nextRow = card.createDiv({ cls: "vault-crews-next-action" });
    nextRow.createSpan({ cls: "vault-crews-next-action-label", text: s.nextActionLabel });
    nextRow.createSpan({ cls: "vault-crews-next-action-text", text: s.nextActionText });
  }

  /** Persistente Statuszeile am Panel-Boden (nur während eines Laufs): trägt den
   *  EINZIGEN Abbrechen-Button (Spec §6.2), aus jedem Tab erreichbar. */
  private renderStatusLine(root: HTMLElement, s: StatusLineVM): void {
    const bar = root.createDiv({ cls: "vault-crews-statusline" });
    bar.createSpan({ cls: "vault-crews-statusline-text", text: s.text });
    const cancel = bar.createEl("button", { cls: "mod-warning vault-crews-cancel", text: s.abortLabel });
    if (s.aborting) {
      cancel.disabled = true;
    } else {
      cancel.addEventListener("click", () => {
        if (this.runState.kind !== "running" || this.runState.aborting) return;
        this.runState = markAborting(this.runState);
        this.render();
        this.host.abortCurrentRun();
      });
    }
  }
}
