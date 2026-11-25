/** Mitschnitt je Modellaufruf (`calls.jsonl.gz`): rein, kein `obsidian`-Import.
 *
 *  Die Aufzeichnung geschieht am Draht (Kit `recordingTransport`, in `main.ts` um die Transporte des Chat-Clients gelegt); dieser Baustein
 *  puffert die Austausche (`createCallRecorder`) und macht aus ihnen die Zeilen (`buildCallEntries`). Geschrieben, geschwärzt und gepackt wird
 *  im Orchestrator, weil nur er die Lauf-Id und den Lauf-Ordner kennt.
 *
 *  Bilder kommen in vault-crews nicht vor; die Regel „ein Bild steht als Prüfsumme im Eintrag“ wird erst mit einem Bild-Collector gebaut
 *  (Quelle: focus-crew, Erweiterung 7). */
import type { TransportExchange } from '../vendor/kit/recording-transport';
import { redactKeysInValue, redactText } from '../vendor/kit/redact';
import { isPlainObject } from '../vendor/kit/settings_schema';

/** Die Felder einer Zeile in ihrer Reihenfolge (das gemeinsame Format mit focus-crew). Einzige Stelle; `CallLogEntry` und `buildCallEntries` folgen ihr,
 *  ein Test hält sie gleich. */
export const CALL_LOG_FIELDS = [
	'nr', 'lauf', 'kontext', 'versuch', 'gestartet', 'dauer_s', 'status', 'anfrage', 'antwort',
	'content', 'reasoning', 'reasoning_feld', 'finish_reason', 'fehler',
] as const;

/** Die Statuswerte einer Zeile, einzige Stelle. Die Wörter der focus-crew-Spec waren beim Bau nicht lesbar (Repo nicht geklont): weichen sie ab, ändert sich nur diese Tabelle. */
export const CALL_STATUS = {
	ok: 'ok',
	/** HTTP 200, aber weder Antworttext noch Denken, und kein Fehler: kein Erfolg. */
	leer: 'leer',
	/** `finish_reason: length`. */
	abgeschnitten: 'abgeschnitten',
	/** Die Anfrage trug `stream: false`, die Rohantwort ist ein Datenstrom (SSE): nur im Fallback ohne Stream möglich. */
	datenstromTrotzStreamFalse: 'datenstrom_trotz_stream_false',
	httpFehler: 'http_fehler',
	ueberlauf: 'ueberlauf',
	zeitueberschreitung: 'zeitueberschreitung',
	stille: 'stille',
	abgebrochen: 'abgebrochen',
	/** Kein HTTP-Status: Verbindung verweigert oder abgebrochen, bevor etwas ankam; auch der abgelehnte Stream, nach dem der Fallback antwortet. */
	netzfehler: 'netzfehler',
} as const;
export type CallStatus = (typeof CALL_STATUS)[keyof typeof CALL_STATUS];

/** Welches Feld der Rohantwort das Denken trug. */
export type ReasoningField = 'reasoning_content' | 'reasoning' | 'thinking' | 'think-tag' | 'channel';

export interface CallLogEntry {
	nr: number;
	lauf: string;
	kontext: string;
	versuch: number;
	/** ISO-8601 (UTC). */
	gestartet: string;
	dauer_s: number;
	status: CallStatus;
	anfrage: { url: string; body: unknown };
	antwort: { http_status: number | null; body: unknown; roh: string };
	content: string;
	reasoning: string;
	reasoning_feld: ReasoningField | null;
	finish_reason: string | null;
	fehler: string | null;
}

/** Was nach dem Aufruf feststeht: das Ergebnis des Clients oder der Fehler, den er warf. */
export interface CallOutcome {
	result: { content: string; reasoning: string; finishReason: string | null; aborted: boolean } | null;
	error: { kind: 'overflow' | 'timeout' | 'stalled' | 'http' | 'other'; message: string } | null;
}

export interface CallRecorder {
	/** Nimmt einen Austausch vom `recordingTransport` an (`sink`). */
	accept(x: TransportExchange): void;
	/** Gibt die seit dem letzten Aufruf angenommenen Austausche heraus und leert den Puffer. */
	take(): TransportExchange[];
}

export function createCallRecorder(): CallRecorder {
	let buffer: TransportExchange[] = [];
	return {
		accept(x) { buffer.push(x); },
		take() { const out = buffer; buffer = []; return out; },
	};
}

/** Die Kennung eines Aufrufs für die Zeilen: Lauf, Kontext, laufende Nummern. `kontext` ist der Schritt, bei `per_note` mit der Notiz. */
export interface CallLogIds { lauf: string; kontext: string; firstNr: number; firstVersuch: number; }

const ERROR_STATUS: Record<NonNullable<CallOutcome['error']>['kind'], CallStatus> = {
	overflow: CALL_STATUS.ueberlauf,
	timeout: CALL_STATUS.zeitueberschreitung,
	stalled: CALL_STATUS.stille,
	http: CALL_STATUS.httpFehler,
	other: CALL_STATUS.netzfehler,
};


function isOk(status: number | null): boolean {
	return status !== null && status >= 200 && status < 300;
}

/** Die geparste JSON-Antwort, wenn die Rohantwort ein einzelnes JSON ist (Fallback ohne Stream, Fehlerkörper), sonst `null`. */
function parseBody(raw: string): unknown {
	const t = raw.trim();
	if (!t.startsWith('{') && !t.startsWith('[')) return null;
	try { return JSON.parse(t) as unknown; } catch { return null; }
}

/** Welches Feld trug das Denken? Aus dem Rohtext bestimmt (ein zweiter SSE-Parser ist das nicht: Text und Denken kommen vom Client, hier wird nur das Feld gesucht).
 *  `null`, wenn es kein Denken gab. */
export function reasoningFieldOf(raw: string, reasoning: string): ReasoningField | null {
	if (reasoning === '') return null;
	if (/"reasoning_content"\s*:\s*"[^"]/.test(raw)) return 'reasoning_content';
	if (/"reasoning"\s*:\s*"[^"]/.test(raw)) return 'reasoning';
	if (/"thinking"\s*:\s*"[^"]/.test(raw)) return 'thinking';
	if (raw.includes('<think>') || raw.includes('</think>')) return 'think-tag';
	if (raw.includes('<channel|>') || raw.includes('<|channel>')) return 'channel';
	return null;
}

function statusOf(x: TransportExchange, last: boolean, outcome: CallOutcome): { status: CallStatus; fehler: string | null } {
	// Ein Austausch, auf den noch einer folgt, ist der abgelehnte Stream vor dem Fallback.
	if (!last) return { status: CALL_STATUS.netzfehler, fehler: x.error ?? null };
	const sentNoStream = isPlainObject(x.body) && x.body.stream === false;
	if (isOk(x.status) && sentNoStream && /^\s*data:/m.test(x.raw)) {
		return { status: CALL_STATUS.datenstromTrotzStreamFalse, fehler: outcome.error?.message ?? null };
	}
	if (outcome.error !== null) return { status: ERROR_STATUS[outcome.error.kind], fehler: outcome.error.message };
	const r = outcome.result;
	if (r === null) return { status: CALL_STATUS.netzfehler, fehler: x.error ?? null };
	if (r.aborted) return { status: CALL_STATUS.abgebrochen, fehler: x.error ?? null };
	if (r.finishReason === 'length') return { status: CALL_STATUS.abgeschnitten, fehler: null };
	if (isOk(x.status) && r.content === '' && r.reasoning === '') return { status: CALL_STATUS.leer, fehler: null };
	return { status: CALL_STATUS.ok, fehler: null };
}

/** Macht aus den Austauschen EINES Client-Aufrufs (`stream()`) die Zeilen. Ergebnis und Fehler gehören nur zum letzten Austausch; der erste eines Fallbacks
 *  (XHR abgelehnt, dann `requestUrl`) bekommt den Status `netzfehler`. Die Felder stehen in der Reihenfolge von `CALL_LOG_FIELDS`. */
export function buildCallEntries(exchanges: readonly TransportExchange[], outcome: CallOutcome, ids: CallLogIds): CallLogEntry[] {
	return exchanges.map((x, i) => {
		const last = i === exchanges.length - 1;
		const { status, fehler } = statusOf(x, last, outcome);
		const r = last ? outcome.result : null;
		const reasoning = r?.reasoning ?? '';
		return {
			nr: ids.firstNr + i,
			lauf: ids.lauf,
			kontext: ids.kontext,
			versuch: ids.firstVersuch + i,
			gestartet: new Date(x.startedAt).toISOString(),
			dauer_s: Math.round(Math.max(0, x.endedAt - x.startedAt)) / 1000,
			status,
			anfrage: { url: x.url, body: x.body },
			antwort: { http_status: x.status, body: parseBody(x.raw), roh: x.raw },
			content: r?.content ?? '',
			reasoning,
			reasoning_feld: reasoningFieldOf(x.raw, reasoning),
			finish_reason: r?.finishReason ?? null,
			fehler,
		};
	});
}

/** Schwärzt eine Zeile für den Vault: `content` und `reasoning` tragen die Klartext-Originale (der Kit-Client setzt Geheimnisse aus den Notizen nach der Antwort wieder
 *  ein), deshalb zuerst mit den Standardregeln des Kits, die er vor dem Senden anwendet; dann die ganze Zeile mit der Schlüsselliste der Endpunkte
 *  (`redactKeysInValue`, wie `persist()`). Wirft fail-closed (kein JSON-Abbild): der Aufrufer macht daraus `RedactionFailed`. */
export function redactCallEntry(entry: CallLogEntry, keys: readonly (string | undefined)[]): CallLogEntry {
	const masked: CallLogEntry = {
		...entry,
		content: redactText(entry.content).text,
		reasoning: redactText(entry.reasoning).text,
	};
	return redactKeysInValue(masked, keys);
}

/** Eine Zeile der Datei (mit Zeilenumbruch). `JSON.stringify` lässt U+2011, U+202F und Emoji unverändert. */
export function serializeCallEntry(entry: CallLogEntry): string {
	return `${JSON.stringify(entry)}\n`;
}
