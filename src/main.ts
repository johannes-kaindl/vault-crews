// Plugin-Shell (Task 16b): verdrahtet ALLE bereits gebauten Teile — Ports, Settings,
// i18n, Commands, Run-Panel, Crash-Recovery und die Ein-Lauf-Ausführung. main.ts ist
// bewusst dünn: es entscheidet nichts über den Lauf-Ablauf (das lebt im puren
// Orchestrator), sondern instanziiert Ports genau einmal, hält den Ein-Lauf-Mutex und
// leitet Orchestrator-Events an Panel + Statusbar + Notices weiter.
//
// Reihenfolge im onload (PROF-OBS-07): registerI18n() + setLang() ZUERST, vor
// addCommand/addRibbonIcon/addSettingTab — sonst rendern die t()-Aufrufe die Keys.
// Netzwerk nur über die injizierten Transports (nie globales fetch); Node/git nur über
// den ChildProcessGitPort hinter Platform.isDesktop.
import {
  FuzzySuggestModal,
  Modal,
  Notice,
  Platform,
  Plugin,
  TFile,
  normalizePath,
  type App,
  type WorkspaceLeaf,
} from "obsidian";
import { pickLang, setLang, t } from "./vendor/kit/i18n";
import { normalizeEndpoint } from "./vendor/kit/endpoint";
import { registerI18n } from "./i18n/strings";
import {
  DEFAULT_SETTINGS,
  SettingsTab,
  type PluginSettings,
  type SettingsHost,
} from "./obsidian/settings";
import {
  RunPanelView,
  VIEW_TYPE_CREWS,
  type PanelHost,
  type PanelTeam,
} from "./obsidian/panel";
import { RecoveryModal, checkOrphanedRun } from "./obsidian/recovery";
import { installExampleCrews } from "./obsidian/install-examples";
import { ObsidianMetadataPort, ObsidianVaultPort } from "./obsidian/vault-port";
import { RequestUrlJsonTransport, XhrSseTransport } from "./obsidian/transports";
import { ChildProcessGitPort } from "./obsidian/git-port";
import { LmStudioClient } from "./core/lmstudio-client";
import { executeRun, type RunDeps } from "./core/orchestrator";
import { parseTeamDef } from "./core/crew-parser";
import { buildDenylist } from "./core/paths";
import type { ClockPort, GitPort, LlmClient, MetadataPort, RunEvent, RunReporter, VaultPort } from "./core/ports";
import type { RunLimits, RunResult, RunStatus } from "./core/types";

/** Feste V1-Grenzen, die die Settings-UI (bewusst) nicht exponiert. */
const MAX_NOTE_BYTES = 65_536;
/** Platzhalter-Deckel: der Orchestrator ersetzt maxLlmCalls im Preflight per Team
 *  (`llmTasks.length * 2`), BEVOR irgendein Call gezählt wird (parseTeamAndAgents ist
 *  der erste Preflight-Schritt) — dieser Wert gatet also nie einen echten Call, er ist
 *  nur eine defensive Obergrenze für ein pathologisch parse-loses Team. */
const MAX_LLM_CALLS_CEILING = 64;

interface LastRunInfo {
  status: RunStatus;
  when: number;
  runId: string;
  commitSha: string | null;
}
type LastRuns = Record<string, LastRunInfo>;

/** Leichte Team-Kopfdaten für Picker + Panel-Liste (id/name/description). Der letzte
 *  Lauf-Status wird erst in getTeams() aus `lastRuns` dazugemischt. */
interface TeamListEntry {
  id: string;
  name: string;
  description: string;
}

export default class VaultCrewsPlugin extends Plugin implements SettingsHost, PanelHost {
  // Basisklasse deklariert `settings?: unknown` (Obsidian 1.13.0) — hier auf den
  // konkreten Typ verengen (empfohlenes Muster), ohne ein eigenes Feld zu emittieren.
  declare settings: PluginSettings;

  private lastRuns: LastRuns = {};
  private teamCache: TeamListEntry[] = [];

  private vault!: VaultPort;
  private meta!: MetadataPort;
  private git!: GitPort;
  private llm!: LlmClient;
  private clock!: ClockPort;

  private statusBarEl: HTMLElement | null = null;

  // Ein-Lauf-Mutex (Spec §6.2 „genau ein Lauf gleichzeitig"): synchron in runCrew
  // gesetzt, in einem finally wieder freigegeben.
  private runActive = false;
  private abortController: AbortController | null = null;

  async onload(): Promise<void> {
    registerI18n();
    setLang(pickLang(readObsidianLocale()));

    await this.loadSettings();
    this.initPorts();

    this.registerView(VIEW_TYPE_CREWS, (leaf) => new RunPanelView(leaf, this));
    // Ribbon öffnet NUR das Panel — kein Direktstart, kein versehentlicher Lauf (§6.1).
    this.addRibbonIcon("list-checks", t("cmd.openPanel"), () => {
      void this.activatePanel();
    });
    this.statusBarEl = this.addStatusBarItem();

    this.addSettingTab(new SettingsTab(this, this));
    this.registerStaticCommands();

    // Team-Liste (dynamische Commands + Panel-Liste) und Crash-Recovery erst nach
    // onLayoutReady, wenn der metadataCache steht (im Test synchron ausgeführt).
    this.app.workspace.onLayoutReady(() => {
      void this.initDeferred();
    });
  }

  onunload(): void {
    // KEIN detachLeavesOfType hier (obsidianmd/detach-leaves): Obsidian stellt die
    // Leaf-Position beim nächsten Load selbst wieder her. Einen laufenden Lauf sicher
    // abbrechen — Abbrechen ist immer folgenlos (Spec §6.2).
    this.abortController?.abort();
  }

  // ── Settings-Persistenz (SettingsHost) ─────────────────────────────────────

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Record<string, unknown> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
    this.lastRuns = raw && isRecord(raw.lastRuns) ? (raw.lastRuns as LastRuns) : {};
    // lastRuns ist ein eigenes data.json-Feld, nicht Teil von PluginSettings —
    // aus dem Merge-Ergebnis wieder entfernen, damit `settings` sauber bleibt.
    delete (this.settings as unknown as Record<string, unknown>).lastRuns;
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, lastRuns: this.lastRuns });
  }

  async testConnection(endpoint: string): Promise<{ ok: boolean; models: string[] }> {
    const ok = await this.llm.ping(endpoint);
    if (!ok) return { ok: false, models: [] };
    try {
      return { ok: true, models: await this.llm.listModels() };
    } catch {
      return { ok: true, models: [] };
    }
  }

  // ── Port-Verdrahtung (genau einmal) ───────────────────────────────────────

  private initPorts(): void {
    this.vault = new ObsidianVaultPort(this.app);
    this.meta = new ObsidianMetadataPort(this.app);
    this.git = new ChildProcessGitPort(resolveVaultRoot(this.app));
    this.clock = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => {
        window.clearTimeout(id);
      },
    };
    const base = normalizeEndpoint(this.settings.endpoints[0] ?? "http://localhost:1234");
    this.llm = new LmStudioClient(
      base,
      new XhrSseTransport(),
      new RequestUrlJsonTransport(),
      this.clock,
      { callTimeoutMs: this.settings.callTimeoutS * 1000, stallTimeoutMs: this.settings.stallTimeoutS * 1000 },
    );
  }

  private buildLimits(): RunLimits {
    return {
      maxWrites: this.settings.maxWrites,
      maxLlmCalls: MAX_LLM_CALLS_CEILING,
      wallClockMs: this.settings.wallClockMinutes * 60_000,
      maxNoteBytes: MAX_NOTE_BYTES,
      callTimeoutMs: this.settings.callTimeoutS * 1000,
      stallTimeoutMs: this.settings.stallTimeoutS * 1000,
    };
  }

  // ── Commands (§6.1) ────────────────────────────────────────────────────────

  private registerStaticCommands(): void {
    this.addCommand({ id: "run-crew", name: t("cmd.runCrew"), callback: () => { this.openTeamPicker(); } });
    this.addCommand({ id: "abort-current-run", name: t("cmd.abortRun"), callback: () => { this.abortCurrentRun(); } });
    this.addCommand({ id: "undo-last-run", name: t("cmd.undoLastRun"), callback: () => { this.undoLastRun(); } });
    this.addCommand({ id: "open-crews-panel", name: t("cmd.openPanel"), callback: () => { void this.activatePanel(); } });
    this.addCommand({ id: "open-last-run-log", name: t("cmd.openLastRunLog"), callback: () => { this.openLog(); } });
    this.addCommand({ id: "install-example-crews", name: t("cmd.installExamples"), callback: () => { void this.installExamples(); } });
  }

  /** Dynamische Per-Team-Commands mit stabiler ID aus dem Datei-Slug (§6.1,
   *  hotkey-fähig). Re-Registrierung derselben ID ist in Obsidian idempotent
   *  (app.commands.addCommand keyt auf die ID). */
  private registerTeamCommands(): void {
    for (const team of this.teamCache) {
      this.addCommand({
        id: `run-crew:${team.id}`,
        name: t("cmd.runCrewNamed", team.name),
        callback: () => { this.runCrew(team.id); },
      });
    }
  }

  private async initDeferred(): Promise<void> {
    try {
      await this.refreshTeams();
      this.registerTeamCommands();
      await this.checkRecovery();
    } catch {
      // Best-effort Hintergrund-Init: bei einem Fehler bleibt die Team-Liste leer,
      // ein Reload versucht es erneut. Kein UI-Lärm.
    }
  }

  // ── Run-Ausführung (Ein-Lauf-Mutex + AbortController) ──────────────────────

  /** PanelHost.runCrew — synchron: Mutex prüfen/setzen, dann den asynchronen Lauf
   *  anstoßen. Ist bereits ein Lauf aktiv, genau eine Notice und Rückkehr. */
  runCrew(teamId: string): void {
    if (this.runActive) {
      new Notice(t("notice.run.inProgress"));
      return;
    }
    this.runActive = true;
    const controller = new AbortController();
    this.abortController = controller;
    void this.executeRunFor(teamId, controller);
  }

  private async executeRunFor(teamId: string, controller: AbortController): Promise<void> {
    let finished = false;
    const reporter: RunReporter = {
      emit: (e) => {
        if (e.type === "runFinished") finished = true;
        this.onRunEvent(teamId, e);
      },
    };
    const teamPath = `${this.settings.crewRoot}/teams/${teamId}.md`;
    const deps: RunDeps = {
      vault: this.vault,
      meta: this.meta,
      llm: this.llm,
      git: this.git,
      clock: this.clock,
      reporter,
      settings: {
        crewRoot: this.settings.crewRoot,
        defaultModel: this.settings.defaultModel,
        configDir: this.app.vault.configDir,
        endpoints: this.settings.endpoints,
        deniedEndpoints: this.settings.deniedEndpoints,
        limits: this.buildLimits(),
      },
      abort: controller.signal,
    };
    try {
      await executeRun(teamPath, deps);
    } catch {
      // executeRun fängt intern und emittiert runFinished selbst; ein hartes Throw ist
      // ein unerwarteter Programmierfehler — dann trotzdem genau EINE Notice.
      if (!finished) {
        new Notice(t("notice.run.failed", this.teamName(teamId), t("notice.errorKind.io")));
      }
    } finally {
      this.runActive = false;
      this.abortController = null;
    }
  }

  /** Reporter-Senke: jedes Event an eine offene Panel-View spiegeln, die Statusbar
   *  aus den Task-Events treiben und beim Lauf-Ende genau EINE Notice zeigen +
   *  lastRuns persistieren. */
  private onRunEvent(teamId: string, e: RunEvent): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CREWS)) {
      if (leaf.view instanceof RunPanelView) leaf.view.handleEvent(e);
    }
    if (e.type === "taskStarted") {
      this.statusBarEl?.setText(`⚙ ${e.index}/${e.total}`);
    } else if (e.type === "runFinished") {
      this.statusBarEl?.setText("");
      this.onRunFinished(teamId, e.result);
    }
  }

  private onRunFinished(teamId: string, result: RunResult): void {
    this.showRunNotice(this.teamName(teamId), result);
    this.lastRuns[teamId] = {
      status: result.status,
      when: this.clock.now(),
      runId: result.runId,
      commitSha: result.commitSha,
    };
    void this.saveSettings();
  }

  private showRunNotice(teamName: string, result: RunResult): void {
    const reason = result.errorKind !== null ? t(`notice.errorKind.${result.errorKind}`) : t("notice.errorKind.io");
    switch (result.status) {
      case "ok":
        new Notice(t("notice.run.ok", teamName, result.writes));
        break;
      case "partial":
        new Notice(t("notice.run.partial", teamName, result.writes));
        break;
      case "aborted":
        new Notice(t("notice.run.aborted", teamName, result.writes));
        break;
      case "failed":
        new Notice(t("notice.run.failed", teamName, reason));
        break;
      case "refused":
        new Notice(t("notice.run.refused", teamName, reason));
        break;
    }
  }

  // ── PanelHost ──────────────────────────────────────────────────────────────

  getTeams(): PanelTeam[] {
    return this.teamCache.map((tm) => {
      const info = this.lastRuns[tm.id];
      return {
        id: tm.id,
        name: tm.name,
        description: tm.description,
        lastRun: info ? { status: info.status, when: info.when } : null,
      };
    });
  }

  abortCurrentRun(): void {
    if (!this.runActive || this.abortController === null) {
      new Notice(t("notice.run.noActiveRun"));
      return;
    }
    this.abortController.abort();
  }

  undoLastRun(): void {
    void this.startUndo();
  }

  /** Ein Einstieg für „Log öffnen" (ok) UND „Fehlerstelle ansehen" (Fehler): öffnet
   *  in beiden Fällen die run.md des jüngsten Laufs (§6.2). Präzise Sprungnavigation an
   *  den fehlgeschlagenen Task ist optional und hier bewusst nicht implementiert. */
  openLog(): void {
    void this.openLastRunLog();
  }

  // ── Team-Liste + Recovery ──────────────────────────────────────────────────

  private async refreshTeams(): Promise<void> {
    this.teamCache = await this.loadTeamList();
  }

  private async loadTeamList(): Promise<TeamListEntry[]> {
    const root = this.settings.crewRoot;
    let agentIds: string[] = [];
    try {
      agentIds = (await this.meta.listMarkdownFiles(`${root}/agents`)).map(slugFromPath);
    } catch {
      agentIds = [];
    }
    const denylist = buildDenylist(this.app.vault.configDir);
    const limits = this.buildLimits();

    let paths: string[] = [];
    try {
      paths = await this.meta.listMarkdownFiles(`${root}/teams`);
    } catch {
      return [];
    }

    const out: TeamListEntry[] = [];
    for (const path of paths) {
      out.push(await this.parseTeamEntry(path, agentIds, limits, denylist));
    }
    return out;
  }

  /** Vollständige parseTeamDef-Validierung für Name/Beschreibung; scheitert sie (z. B.
   *  Agent noch nicht geladen), fällt es auf die rohen Frontmatter-Felder und zuletzt
   *  auf den Slug zurück — die Team-Zeile erscheint immer, damit der Nutzer sie starten
   *  (und den echten Fehler im Preflight sehen) kann. */
  private async parseTeamEntry(
    path: string,
    agentIds: string[],
    limits: RunLimits,
    denylist: string[],
  ): Promise<TeamListEntry> {
    const id = slugFromPath(path);
    try {
      const fm = await this.meta.getFrontmatter(path);
      const parsed = parseTeamDef(path, fm, { knownAgents: agentIds, maxima: limits, denylist });
      if (parsed.ok) return { id, name: parsed.value.name, description: parsed.value.description };
      if (fm !== null) {
        const name = typeof fm.name === "string" && fm.name.trim() !== "" ? fm.name.trim() : id;
        const description = typeof fm.description === "string" ? fm.description : "";
        return { id, name, description };
      }
    } catch {
      // rohes Lesen fehlgeschlagen → Slug-Fallback
    }
    return { id, name: id, description: "" };
  }

  private async checkRecovery(): Promise<void> {
    const orphan = await checkOrphanedRun(this.vault, this.settings.crewRoot);
    if (orphan !== null) {
      new RecoveryModal(this.app, orphan, { vault: this.vault, git: this.git }).open();
    }
  }

  // ── Command-Implementierungen ──────────────────────────────────────────────

  private openTeamPicker(): void {
    const teams = this.getTeams();
    if (teams.length === 0) {
      new Notice(t("notice.run.noTeams"));
      return;
    }
    new TeamSuggestModal(this.app, teams, (team) => {
      this.runCrew(team.id);
    }).open();
  }

  private async activatePanel(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CREWS);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (leaf === null) {
      leaf = workspace.getRightLeaf(false);
      if (leaf !== null) await leaf.setViewState({ type: VIEW_TYPE_CREWS, active: true });
    }
    if (leaf !== null) void workspace.revealLeaf(leaf);
  }

  private async installExamples(): Promise<void> {
    try {
      const { created } = await installExampleCrews(this.vault, this.settings.crewRoot);
      new Notice(created.length > 0 ? t("notice.install.ok", created.length) : t("notice.install.exists"));
      await this.refreshTeams();
      this.registerTeamCommands();
    } catch {
      new Notice(t("notice.errorKind.io"));
    }
  }

  private async openLastRunLog(): Promise<void> {
    const recent = this.mostRecentRun();
    if (recent === null) {
      new Notice(t("notice.run.noLastRun"));
      return;
    }
    const path = normalizePath(`${this.settings.crewRoot}/runs/${recent.info.runId}/run.md`);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice(t("notice.run.noLastRun"));
    }
  }

  private async startUndo(): Promise<void> {
    const recent = this.mostRecentRun();
    if (recent === null || recent.info.commitSha === null) {
      new Notice(t("notice.run.noLastRun"));
      return;
    }
    const sha = recent.info.commitSha;
    const runState = await this.readRunState(recent.info.runId);
    const files = runState?.writeRegister ?? [];
    const baseSha = runState?.baseSha ?? null;
    const lines = [
      `${t("undo.field.team")}: ${this.teamName(recent.teamId)}`,
      `${t("undo.field.time")}: ${new Date(recent.info.when).toLocaleString()}`,
      `${t("undo.field.commit")}: ${shortSha(sha)}`,
      `${t("undo.field.files")}: ${files.length > 0 ? files.join(", ") : "—"}`,
    ];
    new ConfirmModal(this.app, {
      title: t("undo.title"),
      lines,
      confirmLabel: t("undo.confirmButton"),
      onConfirm: () => this.performUndo(sha, baseSha, files),
    }).open();
  }

  /** `git revert <sha>` (kein History-Rewrite, §5.3). Konflikt → Notice mit Datei-Zahl
   *  + Angebot, die Original-Dateien pro Konflikt aus base_sha wiederherzustellen
   *  (`restorePaths`) — niemals ein stiller Merge. */
  private async performUndo(sha: string, baseSha: string | null, _files: string[]): Promise<void> {
    const result = await this.git.revert(sha);
    if (result.ok) {
      new Notice(t("notice.undo.ok", shortSha(sha)));
      return;
    }
    new Notice(t("notice.undo.conflict", result.conflictPaths.length));
    if (baseSha === null || result.conflictPaths.length === 0) return;
    const conflicts = result.conflictPaths;
    new ConfirmModal(this.app, {
      title: t("undo.title"),
      lines: [t("notice.undo.conflict", conflicts.length), conflicts.join(", ")],
      confirmLabel: t("notice.undo.restoreOffer"),
      onConfirm: async () => {
        await this.git.restorePaths(baseSha, conflicts);
        new Notice(t("notice.undo.restored", conflicts.length));
      },
    }).open();
  }

  private async readRunState(runId: string): Promise<{ writeRegister: string[]; baseSha: string | null } | null> {
    const path = `${this.settings.crewRoot}/runs/${runId}/state.json`;
    try {
      const parsed: unknown = JSON.parse(await this.vault.read(path));
      if (!isRecord(parsed)) return null;
      const rawWrites = parsed.writeRegister;
      const writeRegister = Array.isArray(rawWrites)
        ? (rawWrites as unknown[]).filter((p): p is string => typeof p === "string")
        : [];
      const baseSha = typeof parsed.baseSha === "string" ? parsed.baseSha : null;
      return { writeRegister, baseSha };
    } catch {
      return null;
    }
  }

  private mostRecentRun(): { teamId: string; info: LastRunInfo } | null {
    let best: { teamId: string; info: LastRunInfo } | null = null;
    for (const [teamId, info] of Object.entries(this.lastRuns)) {
      if (best === null || info.when > best.info.when) best = { teamId, info };
    }
    return best;
  }

  private teamName(teamId: string): string {
    return this.teamCache.find((tm) => tm.id === teamId)?.name ?? teamId;
  }
}

// ── Modals ─────────────────────────────────────────────────────────────────

/** Fuzzy-Picker über Teams (§6.1): jede Zeile = Name + letzter Lauf-Status. */
class TeamSuggestModal extends FuzzySuggestModal<PanelTeam> {
  constructor(
    app: App,
    private readonly teams: PanelTeam[],
    private readonly onPick: (team: PanelTeam) => void,
  ) {
    super(app);
    this.setPlaceholder(t("cmd.runCrew"));
  }

  getItems(): PanelTeam[] {
    return this.teams;
  }

  getItemText(team: PanelTeam): string {
    const status = team.lastRun !== null ? t(`panel.status.${team.lastRun.status}`) : t("panel.idle.never");
    return `${team.name} — ${status}`;
  }

  onChooseItem(team: PanelTeam): void {
    this.onPick(team);
  }
}

interface ConfirmOpts {
  title: string;
  lines: string[];
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}

/** Bestätigungs-Modal mit genau EINEM Aktionsbutton — dient „Undo last run" (Team,
 *  Zeit, Commit, Dateien) und dem Konflikt-Wiederherstellungs-Angebot (§5.3/§6.1).
 *  DOM ausschließlich über createEl (kein innerHTML). */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly opts: ConfirmOpts,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.opts.title });
    for (const line of this.opts.lines) contentEl.createEl("p", { text: line });
    const btn = contentEl.createEl("button", { cls: "mod-cta", text: this.opts.confirmLabel });
    btn.addEventListener("click", () => {
      this.close();
      void this.opts.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── freie Helfer ─────────────────────────────────────────────────────────────

/** Vault-Wurzel als absoluter Dateisystem-Pfad für den GitPort — nur auf Desktop und
 *  nur wenn der Adapter getBasePath() bietet (FileSystemAdapter). Duck-typing statt
 *  `instanceof FileSystemAdapter`, damit der Test-Mock (ohne diesen Export) nicht
 *  bricht; auf Mobile/ohne Basispfad bleibt es "" (das Plugin ist isDesktopOnly). */
function resolveVaultRoot(app: App): string {
  const adapter: unknown = app.vault.adapter;
  if (Platform.isDesktop && hasBasePath(adapter)) return adapter.getBasePath();
  return "";
}

function hasBasePath(a: unknown): a is { getBasePath(): string } {
  return typeof a === "object" && a !== null && typeof (a as { getBasePath?: unknown }).getBasePath === "function";
}

/** Obsidian-UI-Sprache best-effort aus dem seit jeher stabilen localStorage-Key
 *  `language` (getLanguage() gäbe es erst ab 1.8.7, minAppVersion ist 1.7.2). Member-
 *  Zugriff `window.localStorage` (kein bare-global, daher nicht restricted); in einer
 *  window-losen Umgebung wirft der Zugriff → null, pickLang fällt auf 'en'. */
function readObsidianLocale(): string | null {
  try {
    return window.localStorage.getItem("language");
  } catch {
    return null;
  }
}

function slugFromPath(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
