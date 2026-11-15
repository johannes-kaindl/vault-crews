/** Geteilte Datentypen des pure-Layers — Quelle: Interface-Skelett
 *  Cockpit _SDD/2026-07-02-vault-crews-v1-interfaces.md (bindend). */

export interface AgentDef {
	id: string;
	name: string;
	model: string | null;
	/** Nur gesetzt, wenn die Persona eine `temperature` im Frontmatter nennt — sie ist dann die
	 *  oberste Überschreibungsebene (Persona > Plugin-Überschreibung > Profilwert). Fehlt sie,
	 *  gilt der Profilwert des Modus (structured: 0.1). */
	temperature?: number;
	/** Token-Budget des Agenten (Default 2048); das Profil kann es für Denkstufen anheben. */
	maxTokens: number;
	thinking: 'auto' | 'on' | 'off';
	systemPrompt: string;
}

export type CollectorId = 'vault.list' | 'vault.read' | 'tasknotes.query';
export type SchemaId = 'triage-v1' | 'briefing-v1';
export type ActionType = 'frontmatter.patch' | 'note.create' | 'note.append' | 'section.replace' | 'note.move';

/** Woher die erlaubten Werte eines Feldes kommen (`values.<feld>.from` in der Crew-Datei): eine feste Liste, die Tags des Vaults
 *  oder die Namen der zuletzt geänderten Notizen eines Ordners (der Wert ist dann der Wikilink). */
export type ValueSource =
	| { kind: 'list'; list: string[] }
	| { kind: 'tags' }
	| { kind: 'notes'; folder: string };

export type OutputSpec =
	/** `values`: Wertemenge je Feld aus dem Bestand (ersetzt die aus den Eingaben); `addTo`: Felder, deren Wert zur vorhandenen Liste
	 *  hinzukommt, statt sie zu ersetzen. Beides ist bei `allowedKeys: '*'` (Alias `triage-v1`) leer. */
	| { family: 'frontmatter.set'; allowedKeys: string[] | '*'; values: Record<string, ValueSource>; addTo: string[] }
	/** `wording`: `briefing` ist der Wortlaut von `briefing-v1` (Golden-Test, byte-genau), `neutral` der von `output: { family: section.write }`. */
	| { family: 'section.write'; maxChars: number; wording: 'briefing' | 'neutral' }
	/** Hängt den Text ans Ende der Zielnotiz (`note.append`), unter `heading`, wenn gesetzt. */
	| { family: 'text.append'; maxChars: number; heading: string | null }
	/** Legt aus den Einträgen des Modells (`title`, `body`) neue Notizen an: Ordner und Frontmatter sind fest, nur Titel und Text kommen vom
	 *  Modell. `linkSource`: Name des Frontmatter-Feldes, das einen Wikilink auf die bearbeitete Notiz (`per_note`) trägt. */
	| { family: 'notes.create'; folder: string; maxItems: number; frontmatter: Record<string, string | number | string[]>; linkSource: string | null }
	/** Ordnet jede Notiz der Eingabe einem Zielordner zu (Aktion `note.move`): `destinations` sind feste Ziele mit Hinweis, `destinationsFrom` ein Ordner,
	 *  dessen direkte Unterordner zur Laufzeit dazukommen. Die fertige Liste baut der Orchestrator (`resolveDestinations`). */
	| { family: 'note.file'; destinations: Destination[]; destinationsFrom: string | null };

/** Ein Zielordner für das Ablegen einer Notiz (Familie `note.file`): `when` sagt dem Modell, wann er passt; `null` heißt ohne Hinweis. */
export interface Destination { folder: string; when: string | null }

export interface CollectorTaskDef {
	id: string;
	kind: 'collector';
	collector: CollectorId;
	params: Record<string, unknown>;
}
export interface LlmTaskDef {
	id: string;
	kind: 'llm';
	agent: string;
	inputs: string[];
	instruction: string;
	output: OutputSpec;
	onError: 'abort' | 'skip';
	/** Crew-Datei `per_note`: ein Modellaufruf je Notiz der Eingaben statt eines Aufrufs für alle (Standard false). */
	perNote: boolean;
}
export interface ActionsTaskDef {
	id: string;
	kind: 'actions';
	inputs: string[];
	allowedActions: ActionType[];
	allowedKeys: string[] | null;
	target: string | null;
	createIfMissing: boolean;
}
export type TaskDef = CollectorTaskDef | LlmTaskDef | ActionsTaskDef;

export interface TeamDef {
	id: string;
	name: string;
	version: number;
	description: string;
	trigger: 'manual' | 'interval';
	/** Nur bei `trigger: interval` gesetzt (Minuten, Heartbeat). */
	intervalMinutes?: number;
	maxWrites: number;
	writeScope: string[];
	tasks: TaskDef[];
	/** Vorschau vor dem Schreiben. In Schritt 1 des Ausbaus nur `false` (der Parser lehnt `true` ab). */
	review: boolean;
	sourcePath: string;
}

export interface CollectedFile {
	path: string;
	contentHash: string;
	frontmatter: Record<string, unknown> | null;
	content: string | null;
}
export interface Artifact {
	taskId: string;
	json: unknown;
	files: CollectedFile[];
	slugTables: Record<string, SlugTableData>;
	/** Pfad → gezeigte und volle Zeichenzahl, wo der Collector den Inhalt gekürzt hat (Einzelkappung oder Gesamtkappung); `shown: 0`
	 *  heißt: wegen der Gesamtkappung gar nicht gelesen. Fehlt, wenn nichts gekürzt wurde. Nicht Teil von `json` und damit nicht im Prompt. */
	truncated?: Record<string, { shown: number; total: number }>;
}

export type FmScalar = string | number | null;
export type FmValue = FmScalar | (string | number)[];

export interface FrontmatterPatchAction {
	type: 'frontmatter.patch';
	path: string;
	set: Record<string, FmValue>;
	remove: string[];
	/** Werte, die zur vorhandenen Liste des Feldes hinzukommen (Vereinigung, ohne Doppelte); fehlt, wenn nichts hinzuzufügen ist. */
	add?: Record<string, (string | number)[]>;
}
export interface NoteCreateAction { type: 'note.create'; path: string; content: string; }
export interface NoteAppendAction { type: 'note.append'; path: string; heading: string | null; content: string; }
export interface SectionReplaceAction { type: 'section.replace'; path: string; content: string; }
/** Verschiebt die Notiz `path` nach `to` (voller Zielpfad mit unverändertem Dateinamen). Obsidian zieht die Links nach. */
export interface NoteMoveAction { type: 'note.move'; path: string; to: string; }
export type Action = FrontmatterPatchAction | NoteCreateAction | NoteAppendAction | SectionReplaceAction | NoteMoveAction;

export type ActionResult = 'applied' | 'rejected' | 'stale' | 'failed';
/** `code` kennzeichnet Ablehnungen von `note.create`, die nicht für die Konsistenz-Schwelle zählen: der Titel ist schon belegt
 *  (`exists`) oder kommt in diesem Durchgang zweimal vor (`duplicate`). Das ist ein Versehen des Modells bei Titeln, kein Zeichen
 *  für eine kaputte Antwort. */
export interface ActionOutcome { action: Action; result: ActionResult; reason: string | null; code?: 'exists' | 'duplicate'; }

export type RunStatus = 'ok' | 'partial' | 'failed' | 'aborted' | 'refused';
export type ErrorKind =
	| 'endpoint_unreachable' | 'endpoint_error' | 'model_missing' | 'timeout' | 'stalled'
	| 'invalid_output' | 'output_truncated' | 'context_overflow' | 'crew_invalid'
	| 'write_limit' | 'consistency' | 'aborted' | 'io'
	/** Preflight: die Crew darf `note.move`, aber Obsidian zieht Links beim Verschieben nicht nach (Einstellung aus, sonst fragt Obsidian im Lauf per Dialog). */
	| 'links_not_followed';

/** Ergebnis einer Notiz in einem `per_note`-Schritt (`TaskRecord.notes`). */
export interface NoteRecord {
	path: string;
	status: 'ok' | 'failed' | 'skipped';
	/** Warum die Notiz nicht `ok` ist (Klartext, steht in run.md). */
	reason: string | null;
	/** Gezeigte und volle Zeichenzahl, wenn der Collector den Inhalt gekürzt hat. */
	truncated: { shown: number; total: number } | null;
}

export interface TaskRecord {
	taskId: string;
	kind: TaskDef['kind'];
	status: 'ok' | 'failed' | 'skipped';
	startedAt: number;
	endedAt: number;
	model: string | null;
	promptHash: string | null;
	thinkTokens: number;
	artifactJson: unknown;
	/** Nur Collector-Tasks: was gefunden wurde und wo gesucht wurde (Alt-Laeufe ohne Feld bleiben gueltig). */
	collected?: { count: number; source: string };
	/** Grund, wenn der Task bewusst nicht gestartet wurde (Klartext, steht in run.md). */
	skipReason?: string;
	outcomes: ActionOutcome[];
	error: { kind: ErrorKind; message: string } | null;
	/** Nur `per_note`-Schritte: eine Zeile je Notiz der Eingaben, in Reihenfolge. */
	notes?: NoteRecord[];
	/** Nur Schritte mit `values`: Klartextzeilen zu den Wertemengen (Kürzung, Werte ohne Kurzform oder mit gleicher Kurzform, leere Menge). */
	valueNotes?: string[];
}
export interface RunState {
	runId: string;
	teamId: string;
	teamPath: string;
	status: RunStatus | 'running';
	startedAt: number;
	endedAt: number | null;
	model: string;
	contextLength: number | null;
	alwaysOnThinker: boolean;
	writeRegister: string[];
	llmCalls: number;
	tasks: TaskRecord[];
	errorTask: string | null;
	errorKind: ErrorKind | null;
}
export interface RunResult {
	runId: string;
	status: RunStatus;
	undoable: boolean;
	writes: number;
	durationS: number;
	errorTask: string | null;
	errorKind: ErrorKind | null;
	alwaysOnThinker: boolean;
	/** Quelle des ersten Collectors, der 0 Notizen fand — sonst null. */
	emptyCollector?: string | null;
	/** Das Modell, das jeder gelaufene `llm`-Task aufgelöst hat (Reihenfolge der Crew); übersprungene und modelllose Tasks fehlen. */
	models?: ReadonlyArray<TaskModel>;
}

/** Das Modell, das ein `llm`-Task im Lauf aufgelöst hat (`rec.model`, nicht der Wert auf dem Draht). */
export interface TaskModel { taskId: string; model: string; }

export interface SlugTableData { toSlug: Record<string, string>; fromSlug: Record<string, string>; }

export interface RunLimits {
	maxWrites: number;
	maxLlmCalls: number;
	wallClockMs: number;
	maxNoteBytes: number;
	callTimeoutMs: number;
	stallTimeoutMs: number;
}
