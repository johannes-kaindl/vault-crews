/** Port-Interfaces (Dependency-Inversion): der pure-Layer kennt nur diese Verträge;
 *  Obsidian-/Node-Implementierungen leben in src/obsidian/. Quelle: Interface-Skelett (bindend). */
import type { ActionOutcome, RunResult } from './types';

export interface VaultPort {
	read(path: string): Promise<string>;
	create(path: string, content: string): Promise<void>;
	modify(path: string, content: string): Promise<void>;
	append(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	patchFrontmatter(path: string, set: Record<string, string | number | null>, remove: string[]): Promise<void>;
}

export interface MetadataPort {
	listMarkdownFiles(folder: string): Promise<string[]>;
	getFrontmatter(path: string): Promise<Record<string, unknown> | null>;
	getBody(path: string): Promise<string>;
}

export interface ClockPort {
	now(): number;
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
}

export interface LlmMessage { role: 'system' | 'user'; content: string; }
export interface LlmParams { model: string; temperature: number; maxTokens: number; thinking: 'auto' | 'on' | 'off'; }
export interface LlmStreamResult { content: string; thinkTokens: number; finishReason: 'stop' | 'length' | 'aborted'; }
export interface ModelInfo { id: string; contextLength: number | null; }
export interface LlmClient {
	ping(endpoint: string): Promise<boolean>;
	/** Retargetiert nachfolgende listModels/modelInfo/stream-Calls auf den übergebenen
	 *  Endpoint (Multi-Endpoint-Failover, Spec §3.1: der in checkEndpointAndModel per
	 *  ping() als erreichbar aufgelöste Endpoint muss auch tatsächlich benutzt werden). */
	setBase(endpoint: string): void;
	listModels(): Promise<string[]>;
	modelInfo(model: string): Promise<ModelInfo | null>;
	stream(messages: LlmMessage[], params: LlmParams, onToken: (t: string) => void, signal: AbortSignal): Promise<LlmStreamResult>;
}

/** Typisierter LLM-Call-Fehler: der Orchestrator entscheidet Fehlerpfade über `kind`
 *  statt über Message-Sniffing (Zusatz-Vertrag zum Skelett, s. Plan Task 12/13). */
export class LlmCallError extends Error {
	constructor(message: string, readonly kind: 'overflow' | 'timeout' | 'stalled' | 'http') {
		super(message);
		this.name = 'LlmCallError';
	}
}

export interface SseTransport {
	postStream(url: string, body: unknown, onChunk: (raw: string) => void, signal: AbortSignal): Promise<number>;
}
export interface JsonTransport {
	getJson(url: string): Promise<unknown>;
	postJson(url: string, body: unknown): Promise<unknown>;
}

export interface GitStatusInfo {
	isRepo: boolean;
	inMergeOrRebase: boolean;
	hasIndexLock: boolean;
	headSha: string | null;
	dirty: boolean;
}
export interface CommitPlan { message: string; paths: string[]; }
export interface GitPort {
	status(): Promise<GitStatusInfo>;
	applyPlan(plan: CommitPlan): Promise<string>;
	revert(sha: string): Promise<{ ok: boolean; conflictPaths: string[] }>;
	restorePaths(sha: string, paths: string[]): Promise<void>;
}

export type RunEvent =
	| { type: 'runStarted'; runId: string; teamId: string }
	| { type: 'taskStarted'; taskId: string; index: number; total: number }
	| { type: 'token'; taskId: string; isThink: boolean }
	| { type: 'taskFinished'; taskId: string; status: 'ok' | 'failed' | 'skipped' }
	| { type: 'actionApplied'; outcome: ActionOutcome }
	| { type: 'runFinished'; result: RunResult };
export interface RunReporter { emit(e: RunEvent): void; }
