// Run-Panel (Spec §6.2 + UI-STANDARD §4): ein einziger View mit interner
// Tab-Navigation (Titel → Hub-Tab-Leiste mit Panels → optionale Statuszeile). Die Tab-Leiste
// ist der Kit-Hub (`buildHubInto`); die View hält runState (aus Orchestrator-Events), den
// aktiven Tab liest sie vom Hub-Steuerkanal. Jedes Hub-Panel rendert das von
// `buildPanelViewModel` gelieferte, deklarative ViewModel via createEl — in `onShow`, und
// bei jedem Event nur für den aktiven Tab. Titel und Statuszeile (der EINZIGE Abbrechen-
// Knopf) liegen außerhalb des Hub-Roots und gelten für alle Tabs. ALLE Entscheidungslogik lebt in der
// puren panel-view-model.ts (node-testbar); dieses Modul trifft keine Entscheidung.
// DOM ausschließlich über createEl/createDiv/createSpan — nie HTML-String-Zuweisung.
import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { t } from "../vendor/kit/i18n";
import { buildHubInto, type HubController, type HubPanel } from "../vendor/kit-obsidian/hub";
import { buildStreamArea, type StreamArea } from "../vendor/kit-obsidian/stream-area";
import type { RunEvent } from "../core/ports";
import type { ErrorKind, RunStatus } from "../core/types";
import type { CrewModelRow } from "../core/model-resolution";
import {
  buildPanelViewModel, buildStatusLineVM, markAborting, reduceRun,
  type BodyVM, type NavState, type RunState,
  type RunSummary, type StatusLineVM, type SummaryVM,
} from "./panel-view-model";

export const VIEW_TYPE_CREWS = "vault-crews-panel";

export type { RunSummary } from "./panel-view-model";

export interface PanelTeam {
  id: string;
  name: string;
  description: string;
  lastRun: { status: RunStatus; when: number; errorKind?: ErrorKind | null; emptyCollector?: string | null } | null;
  /** Erste Parse-Fehlermeldung der Crew-Definition, sonst null. Die Zeile bleibt startbar. */
  problem: string | null;
  /** Modell und Denkstufe je `llm`-Task der Crew (nur lesend angezeigt); leer, wenn die Crew nicht parst. */
  models: CrewModelRow[];
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
  /** Dateien mit `crew-kind:`, die flach im crewRoot liegen statt in teams/ oder agents/. */
  getStrayCrewCount(): number;
  /** Öffnet den Einstellungs-Tab dieses Plugins (der Link der Modellanzeige: dort steht der Rückfall). */
  openSettings(): void;
}

const TAB_ICON: Record<NavState, string> = { crews: "users", history: "history" };

export class RunPanelView extends ItemView {
  private runState: RunState = { kind: "idle" };
  // Der Hub kennt den aktiven Tab; `lastTab` hält nur den Standard-Tab für einen Neuaufbau der View.
  private hub: HubController<NavState> | null = null;
  private lastTab: NavState = "crews";
  private statusHost: HTMLElement | null = null;
  // Referenz auf den Streaming-Antwortbereich (buildStreamArea) für den Token-Fast-Path
  // (handleEvent): nur gültig, solange das Crews-Panel gezeichnet ist (onShow setzt, onHide und
  // jedes Neuzeichnen räumen sie ab).
  private streamArea: StreamArea | null = null;
  // Aufklapp-Zustand des <think>-Bereichs: gehört zur Navigation, nicht zum Lauf — er muss
  // vollen Re-Render überleben, sonst schnappt der Bereich beim ersten Content-Token zu,
  // also genau während man den Gedankengang mitliest.
  private thinkOpen = false;
  // Aufklapp-Zustand der Modell-Zeilen je Crew (`<details>`): gehört wie `thinkOpen` zur Navigation und überlebt volle Renders.
  private readonly modelsOpen = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private readonly host: PanelHost) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_CREWS; }
  getDisplayText(): string { return t("panel.title"); }
  getIcon(): string { return "list-checks"; }

  async onOpen(): Promise<void> {
    this.build();
  }
  async onClose(): Promise<void> {
    this.hub?.destroy();
    this.hub = null;
    this.contentEl.empty();
  }

  /** Treibt runState ausschließlich aus Orchestrator-Events (main.ts verdrahtet
   *  RunReporter.emit → handleEvent). Jedes Event zeichnet den aktiven Tab und die
   *  Statuszeile vollständig neu (DOM = reine Funktion des Zustands), analog zu
   *  SettingsTab.display(). */
  handleEvent(e: RunEvent): void {
    this.runState = reduceRun(this.runState, e);
    if (e.type === "token" && this.tryFastPathToken(e)) return;
    this.render();
  }

  /** Setzt Gedanken bzw. Text im Streaming-Antwortbereich, ohne das Panel neu zu bauen.
   *  `runState.streamText`/`thinkText` sind vom Reducer bereits auf MAX_LIVE_CHARS
   *  gekappt (Tail behalten) — der Fast-Path übernimmt nur, prüft nicht selbst nach.
   *  Der Gedankenblock entsteht dabei lazy (buildStreamArea legt ihn beim ersten
   *  `setReasoning`-Aufruf an), ein Fallback auf den vollen Render ist dafür nicht nötig.
   *  Die `<summary>`-Zeile des Blocks zeigt den Live-Zähler („Denkt … N Token“). */
  private tryFastPathToken(e: Extract<RunEvent, { type: "token" }>): boolean {
    if (this.hub?.currentTab() !== "crews" || this.runState.kind !== "running" || this.streamArea === null) return false;
    if (e.isThink) {
      this.streamArea.setReasoning(this.runState.thinkText);
      this.streamArea.setReasoningSummary(t("panel.thinking", this.runState.thinkCount));
    } else {
      this.streamArea.setTail(this.runState.streamText);
    }
    this.streamArea.followTail();
    return true;
  }

  /** Neu zeichnen, ohne dass sich der Lauf-Zustand geaendert hat — fuer Aenderungen, die
   *  von aussen kommen (eine Crew-Datei wird angelegt, umbenannt, geloescht). Der aktive
   *  Tab und der Aufklapp-Zustand ueberleben, weil sie vom Hub bzw. der View gehalten werden. */
  refreshFromVault(): void {
    this.render();
  }

  private render(): void {
    if (this.hub === null) { this.build(); return; }
    this.hub.refreshActive();
    this.renderStatus();
  }

  /** Baut Titel, Hub und Statuszeilen-Platz neu auf (erster Aufruf, `onOpen`). */
  private build(): void {
    this.hub?.destroy();
    this.hub = null;
    this.streamArea = null;
    const root = this.contentEl;
    root.empty();
    root.addClass("vault-crews-panel");
    root.createEl("h2", { cls: "vault-crews-title", text: t("panel.title") });
    const hubRoot = root.createDiv({ cls: "vault-crews-hub" });
    this.statusHost = root.createDiv({ cls: "vault-crews-statusline-host" });
    // Der erste `onShow` läuft noch in `buildHubInto`, also bevor `this.hub` gesetzt ist: er
    // rendert sein eigenes Panel (`id`) und fragt den Hub nicht nach dem aktiven Tab.
    this.hub = buildHubInto(hubRoot, [this.makePanel("crews"), this.makePanel("history")], this.lastTab);
    this.renderStatus();
  }

  private makePanel(id: NavState): HubPanel<NavState> {
    let container: HTMLElement | null = null;
    return {
      id,
      get label(): string { return t(`panel.tab.${id}`); },
      icon: TAB_ICON[id],
      mount: (el: HTMLElement) => { container = el; },
      onShow: () => {
        this.lastTab = id;
        if (container) this.renderTab(container, id);
      },
      // Inaktive Panels bleiben gemountet, aber leer: so hängt keine veraltete streamArea-Referenz
      // an einem versteckten Knoten, und der nächste onShow zeichnet frisch.
      onHide: () => {
        container?.empty();
        if (id === "crews") this.streamArea = null;
      },
      destroy: () => {},
    };
  }

  // ── Reine Übersetzung ViewModel → DOM (keine Entscheidungslogik) ────────────

  private renderTab(container: HTMLElement, id: NavState): void {
    const vm = buildPanelViewModel({
      navState: id,
      runState: this.runState,
      teams: this.host.getTeams(),
      latest: this.host.getLastRunSummary(),
      nowMs: Date.now(),
      strayCount: this.host.getStrayCrewCount(),
    });
    container.empty();
    // container.empty() wirft den bisherigen Streaming-Antwortbereich weg — die Referenz muss
    // bei jedem Neuzeichnen des Crews-Tabs zurückgesetzt werden, sonst zeigt der Fast-Path auf
    // einen toten Node.
    if (id === "crews") this.streamArea = null;
    this.renderBody(container.createDiv({ cls: "vault-crews-content" }), vm.body);
  }

  private renderStatus(): void {
    if (!this.statusHost) return;
    this.statusHost.empty();
    const line = buildStatusLineVM(this.runState);
    if (line !== null) this.renderStatusLine(this.statusHost, line);
  }

  private renderBody(root: HTMLElement, body: BodyVM): void {
    switch (body.kind) {
      case "crewsIdle": {
        // Steht VOR dem Empty-Zweig: eine verirrte Datei ist genau dann die Erklaerung fuer
        // "keine Crews", und sie bleibt auch bei gefuellter Liste sichtbar.
        if (body.strayText !== null) {
          root.createDiv({ cls: "vault-crews-stray", text: body.strayText });
        }
        if (body.empty) {
          root.createDiv({ cls: "vault-crews-empty", text: body.emptyText });
          const install = root.createEl("button", { cls: "mod-cta", text: body.installLabel });
          install.addEventListener("click", () => { this.host.installExamples(); });
          return;
        }
        const list = root.createDiv({ cls: "vault-crews-team-list" });
        for (const team of body.teams) {
          const row = list.createDiv({ cls: "vault-crews-team-row" });
          const nameEl = row.createDiv({ cls: "vault-crews-team-name" });
          // Bedeutung traegt Form (Dreieck) UND Farbe UND aria-label — nie Farbe allein
          // (UI-STANDARD §8 Status-Indikator, WCAG 1.4.1).
          if (team.problem !== null) {
            const warn = nameEl.createSpan({ cls: "vault-crews-team-problem is-warning" });
            setIcon(warn, "alert-triangle");
            warn.setAttribute("aria-label", team.problem);
          }
          nameEl.createSpan({ text: team.name });
          row.createDiv({ cls: "vault-crews-team-desc", text: team.description });
          row.createDiv({ cls: "vault-crews-team-status", text: team.statusText });
          const runBtn = row.createEl("button", { cls: "vault-crews-run", text: team.runLabel });
          runBtn.addEventListener("click", () => { this.host.runCrew(team.id); });
          // Nur lesend: welches Modell und welche Denkstufe jeder Agent bekommt. Kein Dropdown, kein Schalter (Modell und Denkstufe
          // stehen je Agent in der Persona; ein Schalter änderte nur den Rückfall und stimmte für jede Persona mit eigenem `model:` nicht).
          if (team.models !== null) {
            const models = row.createEl("details", { cls: "vault-crews-team-models" });
            // Der Aufklapp-Zustand gehört zur View, nicht zum Render: ein Neuzeichnen (jedes Lauf-Ereignis) darf ihn nicht zuklappen.
            models.open = this.modelsOpen.has(team.id);
            models.addEventListener("toggle", () => {
              if (models.open) this.modelsOpen.add(team.id); else this.modelsOpen.delete(team.id);
            });
            models.createEl("summary", { cls: "vault-crews-team-models-summary", text: team.models.heading });
            const lines = models.createEl("ul", { cls: "vault-crews-team-models-list" });
            for (const line of team.models.lines) lines.createEl("li", { text: line });
            const settings = models.createEl("a", { cls: "vault-crews-team-models-settings", text: team.models.settingsLabel, attr: { href: "#", role: "button" } });
            settings.addEventListener("click", (ev) => { ev.preventDefault(); this.host.openSettings(); });
          }
        }
        return;
      }
      case "crewsRunning": {
        const list = root.createDiv({ cls: "vault-crews-task-list" });
        for (const line of body.lines) {
          const row = list.createDiv({ cls: "vault-crews-task-row" });
          // Status-Indikator (UI-STANDARD §8): Form + Farbe + Zustandsklasse + aria-label (Statustext).
          const icon = row.createSpan({ cls: `vault-crews-task-icon ${line.icon.cls}`.trim() });
          setIcon(icon, line.icon.name);
          icon.setAttribute("aria-label", line.statusText);
          row.createSpan({ cls: "vault-crews-task-label", text: line.label });
        }
        // Streaming-Antwortbereich aus dem Kit (UI-STANDARD §8, `buildStreamArea`):
        // Gedankenblock (lazy, nur bei vorhandenem Denktext) über dem laufenden Absatz.
        // Aufklapp-Zustand ist Sache der View (`thinkOpen`, überlebt volle Renders), nicht
        // des Kit-Moduls — es speichert selbst nichts (Spec §4 „nie aufgedrängt").
        this.streamArea = buildStreamArea(root, {
          strings: { reasoning: body.thinkingLabel },
          cls: "vault-crews-stream",
          reasoningOpen: this.thinkOpen,
          onReasoningToggle: (open) => { this.thinkOpen = open; },
        });
        if (body.thinkText !== "") this.streamArea.setReasoning(body.thinkText);
        this.streamArea.setTail(body.streamText === "" ? body.streamEmptyText : body.streamText);
        this.streamArea.followTail();
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

  /** Persistente Statuszeile am Panel-Boden, außerhalb des Hub-Roots (nur während eines Laufs): trägt den
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
