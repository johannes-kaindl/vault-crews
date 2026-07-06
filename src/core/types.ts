/** Geteilte Datentypen des pure-Layers — Quelle: Interface-Skelett
 *  docs/superpowers/plans/2026-07-02-vault-crews-v1-interfaces.md (bindend). */

export interface AgentDef {
	id: string;
	name: string;
	model: string | null;
	temperature: number;
	maxTokens: number;
	thinking: 'auto' | 'on' | 'off';
	systemPrompt: string;
}

export type CollectorId = 'vault.list' | 'vault.read' | 'tasknotes.query';
export type SchemaId = 'triage-v1' | 'briefing-v1';
export type ActionType = 'frontmatter.patch' | 'note.create' | 'note.append' | 'section.replace';

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
	outputSchema: SchemaId;
	onError: 'abort' | 'skip';
}
export interface ActionsTaskDef {
	id: string;
	kind: 'actions';
	inputs: string[];
	allowedActions: ActionType[];
	allowedKeys: string[] | null;
	target: string | null;
}
export type TaskDef = CollectorTaskDef | LlmTaskDef | ActionsTaskDef;

export interface TeamDef {
	id: string;
	name: string;
	version: number;
	description: string;
	trigger: 'manual';
	maxWrites: number;
	writeScope: string[];
	tasks: TaskDef[];
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
}

export interface FrontmatterPatchAction {
	type: 'frontmatter.patch';
	path: string;
	set: Record<string, string | number | null>;
	remove: string[];
}
export interface NoteCreateAction { type: 'note.create'; path: string; content: string; }
export interface NoteAppendAction { type: 'note.append'; path: string; heading: string | null; content: string; }
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
	taskId: string;
	kind: TaskDef['kind'];
	status: 'ok' | 'failed' | 'skipped';
	startedAt: number;
	endedAt: number;
	model: string | null;
	promptHash: string | null;
	thinkTokens: number;
	artifactJson: unknown;
	outcomes: ActionOutcome[];
	error: { kind: ErrorKind; message: string } | null;
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
}

export interface SlugTableData { toSlug: Record<string, string>; fromSlug: Record<string, string>; }

export interface RunLimits {
	maxWrites: number;
	maxLlmCalls: number;
	wallClockMs: number;
	maxNoteBytes: number;
	callTimeoutMs: number;
	stallTimeoutMs: number;
}
