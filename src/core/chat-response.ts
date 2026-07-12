/** Pure Interpretation OpenAI-kompatibler Chat-Completion-Responses.
 *  Kein Transport, kein Streaming — nur Response-Shape + Fehler-Klassifikation.
 *  Kein `obsidian`-Import (check:pure). */

const OVERFLOW_RE = /context (length|window)|too many tokens/i;

/** True, wenn der (Fehler-)Body auf ein überschrittenes Kontextfenster hindeutet.
 *  Geteilt zwischen Streaming- und Non-Streaming-Pfad des LocalLlmClient. */
export function isContextOverflow(body: string): boolean {
	return OVERFLOW_RE.test(body);
}

/** Zieht content + reasoning aus einer Non-Streaming /v1/chat/completions-Antwort.
 *  null, wenn kein content extrahierbar ist (echter Fehlerbody) — der Aufrufer
 *  klassifiziert dann via isContextOverflow. */
export function extractChatContent(res: unknown): { content: string; reasoning: string } | null {
	const choices = isRecord(res) && Array.isArray(res.choices) ? (res.choices as unknown[]) : [];
	const choice = choices.length > 0 ? choices[0] : null;
	const msg = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
	const content = msg && typeof msg.content === 'string' ? msg.content : null;
	if (content === null) return null;
	const reasoning = msg && typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
	return { content, reasoning };
}

/** Zieht eine sinnvolle einzeilige Fehler-Message aus einem (bereits geparsten)
 *  JSON-Fehlerbody. Reihenfolge: error.message → error (String) → message.
 *  null, wenn kein bekanntes Feld greift (Aufrufer nutzt dann den Rohbody).
 *  Verhindert D2: firstLine() kollabierte pretty-printed JSON auf "{". */
export function extractErrorMessage(body: unknown): string | null {
	if (!isRecord(body)) return null;
	const err = body.error;
	if (isRecord(err) && typeof err.message === 'string') return err.message;
	if (typeof err === 'string') return err;
	if (typeof body.message === 'string') return body.message;
	return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
