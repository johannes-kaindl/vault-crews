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

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
