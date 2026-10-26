/** Constrain-then-verify, Stufe 1 (Spec §3.4): Jede LLM-Ausgabe ist feindlicher Input.
 *  Extraktion ist tolerant (letzter Fence, Repair-Pass), Validierung ist hart (Schema,
 *  Quellbindung, Slug-Wertemengen). Die JSON-Suche liefert das Kit-Modul `llm-json`. */
import { extractJsonCandidates } from '../vendor/kit/llm-json';
import { unwrapAnswer } from '../vendor/kit/llm-answer';
import type { LlmMessage } from './ports';
import type { SchemaDef } from './schemas';
import type { Action, CollectedFile, SlugTableData } from './types';

export function extractJson(raw: string): { ok: true; json: unknown } | { ok: false; error: string } {
	// Konstanten-Wahl für vault-crews (Kit `llm-json`, code-kit 0.23.0): der LETZTE ```json-Fence —
	// Reasoning-Modelle zitieren in der Präambel gern das Beispiel — und der Repair-Pass für
	// typografische Anführungszeichen und Komma vor der Klammer. Beides ist Pflicht: mit dem
	// Kit-Default kippen drei der sechs Korpus-Fixtures. Ein offenes <think> verwirft den Rest
	// (Kit-Default, Entscheidung Johannes 2026-10-12): seine Klammern stammen aus dem Denken.
	const r = extractJsonCandidates(raw, { fence: 'last', fenceTag: 'json', repair: true });
	if (r.ok) return { ok: true, json: r.values[0] };
	if (r.reason === 'truncated') return { ok: false, error: 'output truncated' };
	if (r.reason === 'no-json') return { ok: false, error: 'no JSON structure found in output' };
	return { ok: false, error: `invalid JSON: ${r.error ?? 'unbekannt'}` };
}

/** Extrahiert rohen Text für 'text'-Schemata (briefing-v1): Denkblöcke weg, EINEN umschließenden Zaun weg (Modelle fencen trotz Anweisung gelegentlich),
 *  trimmen — das ist die Kit-Funktion `unwrapAnswer` (code-kit `llm-answer`, vorher eine eigene Regex hier). Kein JSON-Parsing — genau das ist der Punkt
 *  (Spec-Notiz SchemaDef.outputFormat in schemas.ts). Kann nicht fehlschlagen (anders als extractJson) — im schlimmsten Fall liefert es einen leeren String,
 *  den schema.validate zurückweist. Unterschied zur alten Fassung (Differentialtest in tests/core/output-validator.test.ts): der Tag eines anderen Zauns
 *  (```text) bleibt nicht mehr als erste Zeile stehen, ein Zaun in einer einzigen Zeile wird nicht mehr entzäunt. */
export function extractText(raw: string): string {
	return unwrapAnswer(raw);
}

export function validateOutput(
	raw: string,
	schema: SchemaDef,
	sources: CollectedFile[],
	slugTables: Record<string, SlugTableData>,
	target: string | null,
): { ok: true; json: unknown; actions: Action[] } | { ok: false; errors: string[] } {
	if (schema.outputFormat === 'text') {
		const text = extractText(raw);
		const validated = schema.validate(text, sources, slugTables, target);
		if (!validated.ok) return { ok: false, errors: validated.errors };
		return { ok: true, json: text, actions: validated.actions };
	}
	const extracted = extractJson(raw);
	if (!extracted.ok) return { ok: false, errors: [extracted.error] };
	const validated = schema.validate(extracted.json, sources, slugTables, target);
	if (!validated.ok) return { ok: false, errors: validated.errors };
	return { ok: true, json: extracted.json, actions: validated.actions };
}

export function buildRepairPrompt(raw: string, errors: string[]): LlmMessage[] {
	return [
		{
			role: 'system',
			content: 'Deine vorherige Antwort war ungültig. Antworte erneut, exakt im im System-Prompt geforderten Format.',
		},
		{
			role: 'user',
			content: `Deine vorherige Ausgabe:\n${raw}\n\nKonkrete Fehler:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nAntworte erneut, exakt im im System-Prompt geforderten Format.`,
		},
	];
}
