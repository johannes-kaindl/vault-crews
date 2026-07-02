/** Constrain-then-verify, Stufe 1 (Spec §3.4): Jede LLM-Ausgabe ist feindlicher Input.
 *  Extraktion ist tolerant (letzter Fence, Repair-Pass), Validierung ist hart (Schema,
 *  Quellbindung, Slug-Wertemengen). extractJson/findBalanced basieren auf dem geborgenen
 *  Plan-Entwurf (Workflow-Fragment G3). */
import type { LlmMessage } from './ports';
import type { SchemaDef } from './schemas';
import type { Action, CollectedFile, SlugTableData } from './types';

function stripThink(s: string): string {
	return s.replace(/<think>[\s\S]*?<\/think>/g, '');
}

function normalizeQuotes(s: string): string {
	return s.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'");
}

function findBalanced(s: string): { start: number; end: number } | 'truncated' | null {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charAt(i);
		if (start === -1) {
			if (c === '{' || c === '[') {
				start = i;
				depth = 1;
			}
			continue;
		}
		if (inString) {
			if (escaped) escaped = false;
			else if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '{' || c === '[') depth++;
		else if (c === '}' || c === ']') {
			depth--;
			if (depth === 0) return { start, end: i };
		}
	}
	return start === -1 ? null : 'truncated';
}

function parseCandidate(candidate: string): { ok: true; json: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, json: JSON.parse(candidate) as unknown };
	} catch {
		// Repair-Pass unten.
	}
	const repaired = normalizeQuotes(candidate).replace(/,\s*([}\]])/g, '$1');
	try {
		return { ok: true, json: JSON.parse(repaired) as unknown };
	} catch (e) {
		if (findBalanced(repaired) === 'truncated') return { ok: false, error: 'output truncated' };
		return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
	}
}

export function extractJson(raw: string): { ok: true; json: unknown } | { ok: false; error: string } {
	const text = stripThink(raw);

	// 1. Letzter ```json-Fence — Reasoning-Modelle zitieren in der Präambel gern das Beispiel.
	const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
	const lastFence = fences[fences.length - 1];
	if (lastFence !== undefined) {
		return parseCandidate((lastFence[1] ?? '').trim());
	}

	// 2. Erste balancierte {...}/[...]-Struktur; Scan auf quote-normalisiertem Text
	//    (Ersetzung ist 1:1, Indizes bleiben gültig).
	const span = findBalanced(normalizeQuotes(text));
	if (span === 'truncated') return { ok: false, error: 'output truncated' };
	if (span === null) return { ok: false, error: 'no JSON structure found in output' };
	return parseCandidate(text.slice(span.start, span.end + 1));
}

export function validateOutput(
	raw: string,
	schema: SchemaDef,
	sources: CollectedFile[],
	slugTables: Record<string, SlugTableData>,
	target: string | null,
): { ok: true; json: unknown; actions: Action[] } | { ok: false; errors: string[] } {
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
			content: 'Du korrigierst fehlerhaftes JSON. Ändere nur, was die Fehlerliste verlangt. Antworte mit NUR korrigiertem JSON in einem ```json-Block.',
		},
		{
			role: 'user',
			content: `Deine vorherige Ausgabe:\n${raw}\n\nKonkrete Fehler:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nGib NUR korrigiertes JSON in einem \`\`\`json-Block zurück.`,
		},
	];
}
