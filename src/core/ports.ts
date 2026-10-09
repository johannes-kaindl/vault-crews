/** Port-Interfaces (Dependency-Inversion): der pure-Layer kennt nur diese Verträge;
 *  Obsidian-/Node-Implementierungen leben in src/obsidian/. Quelle: Interface-Skelett (bindend). */
import type { ActionOutcome, FmValue, RunResult } from './types';
import type { EndpointConfig } from '../vendor/kit/endpoint_config';
import type { BackendId, Deviation, FamilyId, ResponseFacts, ThinkingLevel } from '../vendor/kit/sampling-profiles';

export interface VaultPort {
	read(path: string): Promise<string>;
	create(path: string, content: string): Promise<void>;
	modify(path: string, content: string): Promise<void>;
	append(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	patchFrontmatter(path: string, set: Record<string, FmValue>, remove: string[]): Promise<void>;
	/** Datei in den Obsidian-Papierkorb verschieben (fileManager.trashFile) — nie Hard-Delete. */
	trash(path: string): Promise<void>;
}

export interface MetadataPort {
	listMarkdownFiles(folder: string): Promise<string[]>;
	getFrontmatter(path: string): Promise<Record<string, unknown> | null>;
	getBody(path: string): Promise<string>;
}

export interface LlmMessage { role: 'system' | 'user'; content: string; }
/** Was ein Modellaufruf braucht — fertig aufgelöst. Die Werte baut `buildCrewParams`
 *  (crew-request.ts) aus Profil-Tabelle, Plugin-Überschreibung und Persona; der Client sendet
 *  sie unverändert und erfindet nichts dazu. */
export interface LlmParams {
	/** Das Modell, wie Nutzer/Agent es nennen (Anzeige, Log). */
	model: string;
	/** Das Modell, wie es über den Draht geht (nach `aliasOf`-Auflösung). */
	sentModel: string;
	/** Sampling- und Denk-Felder, flach in den Body gemischt. */
	params: Record<string, number | string>;
	/** Die gewünschte Denkstufe — Information für die Always-on-Erkennung
	 *  („Modell dachte trotz off"), nicht für den Draht. */
	thinkingLevel: ThinkingLevel;
	/** Wie der Client geschwärzte Werte in die Antwort zurücksetzt: `json` maskiert sie für JSON-Zeichenketten
	 *  (Schema mit JSON-Ausgabe), `text` setzt sie wörtlich ein (Markdown-Ausgabe). Fehlt das Feld, gilt `json`. */
	restoreContent?: 'text' | 'json';
}
export interface LlmStreamResult {
	content: string; thinkTokens: number; reasoned: boolean; finishReason: 'stop' | 'length' | 'aborted';
	/** Was `checkResponse` aus der Antwort braucht. Fehlt bei Test-Doubles; der echte Client
	 *  liefert es immer. */
	facts?: ResponseFacts;
}

/** Was der pure Orchestrator über das Modell hinter dem Endpunkt nicht selbst wissen kann:
 *  Familie und Draht-Schreibweise (aus dem Manager oder dem Namen), das Backend (Probe) —
 *  und wohin die Sitzung ihre Anfragen und Abweichungen meldet. Die Obsidian-Schicht
 *  implementiert es (main.ts); der Orchestrator wählt den Endpunkt per Failover selbst,
 *  deshalb kann die Antwort erst nach `checkEndpointAndModel` eingeholt werden. */
export interface RequestPort {
	describe(model: string): { family: FamilyId | null; sentModel: string };
	/** Wirft nie; `unknown`, wenn nichts erkannt wird. */
	backendOf(endpoint: EndpointConfig): Promise<BackendId>;
	recordRequest(params: Record<string, number | string>): void;
	report(deviations: Deviation[]): void;
}
export interface ModelInfo { id: string; contextLength: number | null; }
export interface LlmClient {
	/** Probt EINEN Endpunkt — mitsamt seinem Schlüssel, sonst antwortet ein Gateway, das
	 *  ohne Authentifizierung 401 sagt, und die Zeile gilt fälschlich als tot.
	 *  **Wirft nie**: das Kit reicht einen werfenden ping durch und reißt damit die ganze
	 *  Fallback-Kette ab (Falle 4 des Kit-Rollouts, dort als Consumer-Pflicht geführt) —
	 *  ein toter localhost würde sonst verhindern, dass der Zweitendpunkt drankommt. */
	ping(endpoint: EndpointConfig): Promise<boolean>;
	/** Retargetiert nachfolgende listModels/modelInfo/stream-Calls auf den übergebenen
	 *  Endpunkt (Multi-Endpoint-Failover, Spec §3.1: der in checkEndpointAndModel per
	 *  ping() als erreichbar aufgelöste Endpunkt muss auch tatsächlich benutzt werden).
	 *  Nimmt den ganzen Eintrag, nicht nur die URL: sonst müsste zur Laufzeit über einen
	 *  URL-Vergleich beantwortet werden, welcher Schlüssel zum aufgelösten Endpunkt gehört —
	 *  und der Resolver liefert die NORMALISIERTE URL, während der gespeicherte Eintrag roh
	 *  bleibt (Falle 3). */
	setEndpoint(cfg: EndpointConfig): void;
	listModels(): Promise<string[]>;
	modelInfo(model: string): Promise<ModelInfo | null>;
	stream(messages: LlmMessage[], params: LlmParams, onToken: (t: string, isThink: boolean) => void, signal: AbortSignal): Promise<LlmStreamResult>;
}

/** Typisierter LLM-Call-Fehler: der Orchestrator entscheidet Fehlerpfade über `kind`
 *  statt über Message-Sniffing (Zusatz-Vertrag zum Skelett, s. Plan Task 12/13). */
export class LlmCallError extends Error {
	constructor(
		message: string,
		readonly kind: 'overflow' | 'timeout' | 'stalled' | 'http',
		/** Nur bei `http`: Status und Servertext — `checkResponse` erkennt daran eine abgelehnte Anfrage. */
		readonly http?: { status: number; detail: string },
	) {
		super(message);
		this.name = 'LlmCallError';
	}
}

export interface JsonTransport {
	getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
	postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
}

// ── Snapshot-Undo (Design-Spec 2026-07-06 §4): git-freies Sicherheitsnetz über die
//    Obsidian-Adapter-API. buildUndoPlan (undo-plan.ts) rechnet damit; AdapterSnapshotStore
//    (obsidian/) implementiert den Store. ──────────────────────────────────────────────
export interface SnapshotEntry {
	path: string;
	existedBefore: boolean;
	preHash: string | null;   // fnv1a des Pre-Image (null gdw. !existedBefore)
	postHash: string | null;  // fnv1a des Post-Run-Inhalts (finalize; null nach Crash)
	blob: string | null;      // Blob-Dateiname (null gdw. !existedBefore)
}
export interface SnapshotManifest {
	runId: string;
	teamId: string;
	createdAt: number;
	entries: SnapshotEntry[];
}
export interface SnapshotStore {
	/** Pre-Image erfassen; first-write-wins (no-op, wenn Pfad im Lauf schon erfasst).
	 *  Persistiert Blob + Manifest write-ahead. */
	capture(runId: string, teamId: string, createdAt: number, path: string, existedBefore: boolean, preContent: string | null): Promise<void>;
	/** Post-Run-Hashes nachtragen + Retention auf keepLast Läufe prunen. */
	finalize(runId: string, postHashes: Record<string, string>, keepLast: number): Promise<void>;
	load(runId: string): Promise<SnapshotManifest | null>;
	readBlob(runId: string, blob: string): Promise<string>;
	discard(runId: string): Promise<void>;
	list(): Promise<string[]>;
}

export type RunEvent =
	| { type: 'runStarted'; runId: string; teamId: string }
	| { type: 'taskStarted'; taskId: string; index: number; total: number }
	| { type: 'token'; taskId: string; isThink: boolean; text: string }
	| { type: 'taskFinished'; taskId: string; status: 'ok' | 'failed' | 'skipped' }
	| { type: 'actionApplied'; outcome: ActionOutcome }
	| { type: 'runFinished'; result: RunResult };
export interface RunReporter { emit(e: RunEvent): void; }
