# Vault Crews V1 — Verbindliches Interface-Skelett

> Kohärenz-Anker für den Implementierungsplan. Alle Task-Gruppen des Plans und alle
> Implementier-Agenten verwenden EXAKT diese Datei-Pfade, Typ-Namen und Signaturen.
> Abweichungen sind Plan-/Implementierungsfehler. Interne Details (private Helfer,
> Regex, Fehlermeldungs-Wortlaut) sind frei, solange die Verträge halten.
> Spec: `docs/superpowers/specs/2026-07-02-vault-crews-design.md`

## Datei-Map

```
manifest.json                       id=vault-crews, isDesktopOnly=true, minAppVersion=1.7.2
src/main.ts                         Plugin-Klasse, Wiring aller Ports, Command-Registrierung   [obsidian]
src/obsidian/settings.ts            PluginSettings-Interface, DEFAULT_SETTINGS, SettingsTab    [obsidian]
src/obsidian/panel.ts               RunPanelView (ItemView), Statusbar-Update                  [obsidian]
src/obsidian/vault-port.ts          ObsidianVaultPort, ObsidianMetadataPort                    [obsidian]
src/obsidian/transports.ts          XhrSseTransport, RequestUrlJsonTransport                   [obsidian]
src/obsidian/git-port.ts            ChildProcessGitPort (dyn. import child_process)            [obsidian]
src/obsidian/recovery.ts            checkOrphanedRun + RecoveryModal                           [obsidian]
src/obsidian/install-examples.ts    installExampleCrews(vault, root)                           [obsidian]
src/core/types.ts                   ALLE geteilten Datentypen (unten)                          [pure]
src/core/ports.ts                   ALLE Port-Interfaces (unten)                               [pure]
src/core/paths.ts                   normalizeVaultPath, globMatch, isDenied, DENYLIST          [pure]
src/core/crew-parser.ts             parseAgentDef, parseTeamDef                                [pure]
src/core/slug-mapper.ts             buildSlugTable, SlugTable                                  [pure]
src/core/collectors.ts              runCollector                                               [pure]
src/core/prompt-builder.ts          buildPrompt, estimateTokens, fitToBudget                   [pure]
src/core/schemas.ts                 BUILTIN_SCHEMAS (triage-v1, briefing-v1)                   [pure]
src/core/output-validator.ts        extractJson, validateOutput, buildRepairPrompt             [pure]
src/core/action-executor.ts         executeActions                                             [pure]
src/core/git-plan.ts                buildCommitPlan                                            [pure]
src/core/run-log.ts                 buildRunMd, buildStateJson, ERROR_KINDS                    [pure]
src/core/orchestrator.ts            executeRun (FSM)                                          [pure]
src/core/lmstudio-client.ts         LmStudioClient implements LlmClient                        [pure, Transport injiziert]
src/vendor/kit/sse.ts               vendored: parseSSE            (obsidian-kit#0.2.0)
src/vendor/kit/think.ts             vendored: ThinkSplitter       (obsidian-kit#0.2.0)
src/vendor/kit/endpoint.ts          vendored: normalizeEndpoint, resolveActiveEndpoint
src/vendor/kit/i18n.ts              vendored: i18n-Engine (defineStrings, t, setLang)
src/i18n/strings.ts                 defineStrings-Aufruf, EN/DE-Dicts
assets/examples/agents/triage-analyst.md, briefing-analyst.md, briefing-autor.md
assets/examples/teams/task-triage.md, daily-briefing.md
assets/examples/runs.base
tests/__mocks__/obsidian.ts         vendored createObsidianMock + makeFakeEl
tests/helpers/in-memory-vault.ts    InMemoryVaultPort + FixtureMetadataPort
tests/helpers/fake-clock.ts         FakeClock implements ClockPort
tests/helpers/recorder-git.ts       RecorderGitPort
tests/helpers/recorder-reporter.ts  RecorderReporter
tests/helpers/script-llm.ts         ScriptLlmClient (Antworten + Fehlerinjektion per Skript)
tests/fixtures/pallas-tasknotes/*.md   echte anonymisierte TaskNotes-Frontmatter
tests/fixtures/llm-outputs/*.txt       kaputte Modell-Outputs (Korpus)
tests/core/<modul>.test.ts          pro core-Modul eine Test-Datei
tests/golden/daily-briefing.test.ts Golden-Run
```

## Geteilte Typen (`src/core/types.ts`) — verbindlich

```ts
export interface AgentDef {
  id: string;                      // Datei-Slug ohne .md
  name: string;
  model: string | null;            // null → Settings-Default
  temperature: number;             // Default 0.1
  maxTokens: number;               // Default 2048
  thinking: 'auto' | 'on' | 'off'; // Default 'auto'
  systemPrompt: string;            // Note-Body, getrimmt
}

export type CollectorId = 'vault.list' | 'vault.read' | 'tasknotes.query';
export type SchemaId = 'triage-v1' | 'briefing-v1';
export type ActionType = 'frontmatter.patch' | 'note.create' | 'note.append' | 'section.replace';

export interface CollectorTaskDef { id: string; kind: 'collector'; collector: CollectorId; params: Record<string, unknown>; }
export interface LlmTaskDef {
  id: string; kind: 'llm'; agent: string; inputs: string[];
  instruction: string; outputSchema: SchemaId; onError: 'abort' | 'skip';
}
export interface ActionsTaskDef {
  id: string; kind: 'actions'; inputs: string[];
  allowedActions: ActionType[]; allowedKeys: string[] | null;
  target: string | null;           // Ziel-Pfad-Template für erzeugende Schemata (briefing-v1);
                                   // einziger Platzhalter: {{today}} → lokales YYYY-MM-DD (ClockPort)
}
export type TaskDef = CollectorTaskDef | LlmTaskDef | ActionsTaskDef;

export interface TeamDef {
  id: string; name: string; version: number; description: string;
  trigger: 'manual';
  maxWrites: number;               // aus limits.max_writes, gedeckelt durch Settings-Maximum
  writeScope: string[];            // Globs, vault-relativ
  tasks: TaskDef[];
  sourcePath: string;              // _crews/teams/<id>.md
}

export interface CollectedFile {
  path: string;
  contentHash: string;             // FNV-1a hex über Roh-Inhalt
  frontmatter: Record<string, unknown> | null;  // slug-normalisiert
  content: string | null;          // nur bei vault.read
}
export interface Artifact {
  taskId: string;
  json: unknown;                   // collector: { files: CollectedFile[] } | llm: schema-konformes Objekt
  files: CollectedFile[];          // Quellbindungs-Material (bei llm: geerbt aus inputs)
  slugTables: Record<string, SlugTableData>;  // key = Frontmatter-Key
}

export interface FrontmatterPatchAction { type: 'frontmatter.patch'; path: string; set: Record<string, string | number | null>; remove: string[]; }
export interface NoteCreateAction     { type: 'note.create'; path: string; content: string; }
export interface NoteAppendAction     { type: 'note.append'; path: string; heading: string | null; content: string; }
export interface SectionReplaceAction { type: 'section.replace'; path: string; content: string; }
export type Action = FrontmatterPatchAction | NoteCreateAction | NoteAppendAction | SectionReplaceAction;

export type ActionResult = 'applied' | 'rejected' | 'stale' | 'failed';
export interface ActionOutcome { action: Action; result: ActionResult; reason: string | null; }

export type RunStatus = 'ok' | 'partial' | 'failed' | 'aborted' | 'refused';
export type ErrorKind =
  | 'endpoint_unreachable' | 'model_missing' | 'timeout' | 'stalled'
  | 'invalid_output' | 'context_overflow' | 'git_refused' | 'crew_invalid'
  | 'write_limit' | 'consistency' | 'aborted' | 'io';

export interface TaskRecord {
  taskId: string; kind: TaskDef['kind'];
  status: 'ok' | 'failed' | 'skipped';
  startedAt: number; endedAt: number;
  model: string | null; promptHash: string | null; thinkTokens: number;
  artifactJson: unknown; outcomes: ActionOutcome[];
  error: { kind: ErrorKind; message: string } | null;
}
export interface RunState {
  runId: string;                   // YYYY-MM-DD-HHmm-<team-id>
  teamId: string; teamPath: string;
  status: RunStatus | 'running';
  startedAt: number; endedAt: number | null;
  baseSha: string | null; commitSha: string | null;
  model: string; contextLength: number | null;
  writeRegister: string[];         // alle geschriebenen Vault-Pfade
  llmCalls: number;
  tasks: TaskRecord[];
  errorTask: string | null; errorKind: ErrorKind | null;
}
export interface RunResult {
  runId: string; status: RunStatus; commitSha: string | null;
  writes: number; durationS: number;
  errorTask: string | null; errorKind: ErrorKind | null;
}

export interface SlugTableData { toSlug: Record<string, string>; fromSlug: Record<string, string>; }

export interface RunLimits {       // Plugin-Maxima aus Settings
  maxWrites: number;               // Default 10
  maxLlmCalls: number;             // = llm-Tasks × 2
  wallClockMs: number;             // Default 600_000
  maxNoteBytes: number;            // 65_536
  callTimeoutMs: number;           // 300_000
  stallTimeoutMs: number;          // 60_000 (erst nach erstem Token)
}
```

## Ports (`src/core/ports.ts`) — verbindlich

```ts
export interface VaultPort {
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;      // wirft, wenn existiert
  modify(path: string, content: string): Promise<void>;      // ganze Datei ersetzen (nur run.md/state.json!)
  append(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  patchFrontmatter(path: string, set: Record<string, string | number | null>, remove: string[]): Promise<void>;
}
export interface MetadataPort {
  listMarkdownFiles(folder: string): Promise<string[]>;      // rekursiv, vault-relativ
  getFrontmatter(path: string): Promise<Record<string, unknown> | null>;
  getBody(path: string): Promise<string>;                    // Inhalt ohne Frontmatter-Block
}
export interface ClockPort { now(): number; setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number): void; }
export interface LlmMessage { role: 'system' | 'user'; content: string; }
export interface LlmParams { model: string; temperature: number; maxTokens: number; thinking: 'auto' | 'on' | 'off'; }
export interface LlmStreamResult { content: string; thinkTokens: number; finishReason: 'stop' | 'length' | 'aborted'; }
export interface ModelInfo { id: string; contextLength: number | null; }
export interface LlmClient {
  ping(endpoint: string): Promise<boolean>;
  listModels(): Promise<string[]>;
  modelInfo(model: string): Promise<ModelInfo | null>;
  stream(messages: LlmMessage[], params: LlmParams, onToken: (t: string) => void, signal: AbortSignal): Promise<LlmStreamResult>;
}
export class LlmCallError extends Error {           // typisierter Call-Fehler statt Message-Sniffing
  constructor(message: string, readonly kind: 'overflow' | 'timeout' | 'stalled' | 'http');
}
export interface SseTransport {
  postStream(url: string, body: unknown, onChunk: (raw: string) => void, signal: AbortSignal): Promise<number>; // resolves HTTP-Status
}
export interface JsonTransport {
  getJson(url: string): Promise<unknown>;
  postJson(url: string, body: unknown): Promise<unknown>;
}
export interface GitStatusInfo { isRepo: boolean; inMergeOrRebase: boolean; hasIndexLock: boolean; headSha: string | null; dirty: boolean; }
export interface CommitPlan { message: string; paths: string[]; }
export interface GitPort {
  status(): Promise<GitStatusInfo>;
  applyPlan(plan: CommitPlan): Promise<string>;              // Commit-SHA
  revert(sha: string): Promise<{ ok: boolean; conflictPaths: string[] }>;
  restorePaths(sha: string, paths: string[]): Promise<void>;
}
export type RunEvent =
  | { type: 'runStarted'; runId: string; teamId: string }
  | { type: 'taskStarted'; taskId: string; index: number; total: number }
  | { type: 'token'; taskId: string; isThink: boolean }
  | { type: 'taskFinished'; taskId: string; status: 'ok' | 'failed' | 'skipped' }
  | { type: 'actionApplied'; outcome: import('./types').ActionOutcome }
  | { type: 'runFinished'; result: import('./types').RunResult };
export interface RunReporter { emit(e: RunEvent): void; }
```

## Kern-Signaturen (verbindlich)

```ts
// src/core/paths.ts
export function buildDenylist(configDir: string): string[]; // [`${configDir}/**`,'.git/**','_crews/**','_vaultrag/**','.*','**/.*']
                                                            // configDir injiziert (Vault#configDir, obsidianmd/hardcoded-config-path)
export function normalizeVaultPath(p: string): string;      // wirft bei '..'
export function globMatch(pattern: string, path: string): boolean;
export function isDenied(path: string, denylist: string[]): boolean;
export function expandTarget(template: string, nowMs: number): string;  // ersetzt {{today}}
// Konsequenz: parseTeamDef-opts, runCollector-deps und ExecutorContext führen `denylist: string[]`.

// src/core/crew-parser.ts
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export function parseAgentDef(path: string, fm: Record<string, unknown> | null, body: string): ParseResult<AgentDef>;
export function parseTeamDef(path: string, fm: Record<string, unknown> | null, opts: { knownAgents: string[]; maxima: RunLimits }): ParseResult<TeamDef>;

// src/core/slug-mapper.ts
export function buildSlugTable(values: string[]): SlugTableData;

// src/core/collectors.ts
export function runCollector(def: CollectorTaskDef, deps: { vault: VaultPort; meta: MetadataPort }): Promise<Artifact>;
export function fnv1a(s: string): string;                    // hex

// src/core/prompt-builder.ts
export interface BuiltPrompt { messages: LlmMessage[]; promptHash: string; truncated: boolean; }
export function buildPrompt(agent: AgentDef, task: LlmTaskDef, inputs: Artifact[], schema: SchemaDef, budgetTokens: number): BuiltPrompt;
export function estimateTokens(s: string): number;           // ceil(chars/3.5)

// src/core/schemas.ts
export interface SchemaDef {
  id: SchemaId;
  jsonExample: string;             // One-Shot-Beispiel für den Prompt
  validate(json: unknown, sources: CollectedFile[], slugTables: Record<string, SlugTableData>, target: string | null): { ok: true; actions: Action[] } | { ok: false; errors: string[] };
  // triage-v1: json = { items: [{ path, set }] } → FrontmatterPatchAction[] (path quellgebunden)
  // briefing-v1: json = { markdown: string } → [SectionReplaceAction { path: target }] (target Pflicht, vom Orchestrator expandiert)
}
export const BUILTIN_SCHEMAS: Record<SchemaId, SchemaDef>;

// src/core/output-validator.ts
export function extractJson(raw: string): { ok: true; json: unknown } | { ok: false; error: string };
export function validateOutput(raw: string, schema: SchemaDef, sources: CollectedFile[], slugTables: Record<string, SlugTableData>): { ok: true; json: unknown; actions: Action[] } | { ok: false; errors: string[] };
export function buildRepairPrompt(raw: string, errors: string[]): LlmMessage[];

// src/core/action-executor.ts
export interface ExecutorContext { team: TeamDef; task: ActionsTaskDef; limits: RunLimits; writeCount: number; sources: CollectedFile[]; }
export function executeActions(actions: Action[], ctx: ExecutorContext, vault: VaultPort): Promise<{ outcomes: ActionOutcome[]; writes: string[]; taskFailed: boolean }>;
export const CREW_MARKER: (teamId: string) => { start: string; end: string };  // <!-- crew:<id> --> / <!-- /crew:<id> -->

// src/core/git-plan.ts
export function buildCommitPlan(state: RunState, runDir: string): CommitPlan;
// Message: `crew(<teamId>): run <runId> — <status>, <n> Dateien` + Body + Trailer `Crew-Run: <runId>`

// src/core/run-log.ts
export function buildRunMd(state: RunState): string;         // Frontmatter crew-kind: run + Body
export function buildStateJson(state: RunState): string;

// src/core/orchestrator.ts
export interface RunDeps {
  vault: VaultPort; meta: MetadataPort; llm: LlmClient; git: GitPort;
  clock: ClockPort; reporter: RunReporter;
  settings: { crewRoot: string; defaultModel: string; endpoints: string[]; deniedEndpoints: string[]; limits: RunLimits };
  abort: AbortSignal;
}
export function executeRun(teamPath: string, deps: RunDeps): Promise<RunResult>;

// src/core/lmstudio-client.ts
export class LmStudioClient implements LlmClient {
  constructor(endpointBase: string, sse: SseTransport, json: JsonTransport, clock: ClockPort, timeouts: { callTimeoutMs: number; stallTimeoutMs: number });
}
```

## Task-Zuschnitt (19 Tasks, Gruppen G1–G8)

| # | Task | Gruppe | Produces (für spätere Tasks) |
|---|------|--------|------------------------------|
| 1 | Scaffold aus Template, manifest vault-crews, CI-grep-Gate core-Reinheit | G1 | Build/Test-Toolchain |
| 2 | Kit-Module + Obsidian-Mock vendoren (Herkunfts-Header) | G1 | `src/vendor/kit/*`, `tests/__mocks__/obsidian.ts` |
| 3 | `types.ts`, `ports.ts`, `paths.ts` + Test-Helper (in-memory-vault, fake-clock, recorder-*) | G1 | alle obigen Typen/Ports |
| 4 | `crew-parser.ts` | G2 | parseAgentDef/parseTeamDef |
| 5 | `slug-mapper.ts` | G2 | buildSlugTable |
| 6 | `collectors.ts` + Pallas-Fixtures | G2 | runCollector, fnv1a |
| 7 | `prompt-builder.ts` (inkl. Budgeter) | G3 | buildPrompt, estimateTokens |
| 8 | `schemas.ts` + `output-validator.ts` + llm-outputs-Fixture-Korpus | G3 | BUILTIN_SCHEMAS, validateOutput |
| 9 | `action-executor.ts` (Guards vollständig, Property-Tests) | G4 | executeActions |
| 10 | `git-plan.ts` | G4 | buildCommitPlan |
| 11 | `run-log.ts` | G4 | buildRunMd/buildStateJson |
| 12 | `lmstudio-client.ts` + SSE-Stream-Fixtures | G5 | LmStudioClient |
| 13 | `orchestrator.ts` (FSM, PREFLIGHT, Repair, Overflow-Retry, Watchdog, Partial-Commit) | G5 | executeRun |
| 14 | `git-port.ts` + Integrationstests gegen echtes git (Temp-Dir) | G6 | ChildProcessGitPort |
| 15 | `vault-port.ts` + `transports.ts` | G6 | Obsidian-Adapter |
| 16 | `settings.ts` + `i18n/strings.ts` + `main.ts` (Wiring, Commands) | G7 | Plugin lauffähig |
| 17 | `panel.ts` + `recovery.ts` | G7 | Run-Panel, Crash-Recovery |
| 18 | `assets/examples/*` + `install-examples.ts` (DE-Prompts) | G8 | Beispiel-Crews |
| 19 | Golden-Run-Test + Klon-Skript `scripts/clone-vault.sh` + README/AGENTS.md + `npm run deploy`-Probe | G8 | Release-Gate |

## Konventions-Kurzreferenz für alle Tasks

- TDD: erst fehlschlagender Test, dann Implementierung; `npm test` nach jedem Schritt.
- `src/core/**` importiert NIE `obsidian` (CI-grep-Gate aus Task 1).
- Commits: konventionelle Prefixe (`feat:`/`test:`/`chore:`/`docs:`) + Trailer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- i18n: UI-Strings nur über `t(...)`, EN/DE ab dem Task, der den String einführt.
- Keine Inline-eslint-disables; `npm run lint && npm run typecheck && npm test` grün vor jedem Commit.
