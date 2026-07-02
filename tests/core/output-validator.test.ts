import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRepairPrompt, extractJson, validateOutput } from '../../src/core/output-validator';
import { BUILTIN_SCHEMAS } from '../../src/core/schemas';
import type { CollectedFile, SlugTableData } from '../../src/core/types';

const fixture = (name: string): string => readFileSync(join(__dirname, '../fixtures/llm-outputs', name), 'utf8');

const sources: CollectedFile[] = ['10_Aufgaben/steuer.md', '10_Aufgaben/zahnarzt.md'].map((path, i) => ({
	path, contentHash: `hash${i}`, frontmatter: { status: 'backlog' }, content: null,
}));
const slugTables: Record<string, SlugTableData> = {
	priority: {
		toSlug: { '1_hoch_🔴': 'hoch', '2_mittel_🟡': 'mittel', '3_niedrig_🟢': 'niedrig' },
		fromSlug: { hoch: '1_hoch_🔴', mittel: '2_mittel_🟡', niedrig: '3_niedrig_🟢' },
	},
};
const triage = BUILTIN_SCHEMAS['triage-v1'];
const briefing = BUILTIN_SCHEMAS['briefing-v1'];

describe('extractJson (Korpus kaputter Modell-Outputs)', () => {
	it('nimmt den LETZTEN json-Fence (Präambel zitiert Beispiele)', () => {
		const r = extractJson(fixture('preamble-with-example.txt'));
		expect(r.ok).toBe(true);
		if (r.ok) expect((r.json as { items: unknown[] }).items.length).toBe(2);
	});
	it('ignoriert <think>-Reste', () => {
		expect(extractJson(fixture('think-remnants.txt')).ok).toBe(true);
	});
	it('repariert trailing commas', () => {
		expect(extractJson(fixture('trailing-comma.txt')).ok).toBe(true);
	});
	it('repariert smart quotes ohne Fence', () => {
		expect(extractJson(fixture('smart-quotes.txt')).ok).toBe(true);
	});
	it('erkennt abgeschnittene Outputs', () => {
		const r = extractJson(fixture('truncated.txt'));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('truncated');
	});
	it('meldet fehlendes JSON', () => {
		expect(extractJson(fixture('prose-only.txt')).ok).toBe(false);
	});
});

describe('validateOutput mit triage-v1', () => {
	it('happy path: extrahiert, validiert, mappt Slugs zurück, erzeugt Aktionen', () => {
		const r = validateOutput(fixture('preamble-with-example.txt'), triage, sources, slugTables, null);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// set-Werte bleiben Slugs — Rück-Mapping auf Emoji-Originale ist Executor-Stufe 2.
		expect(r.actions).toEqual([
			{ type: 'frontmatter.patch', path: '10_Aufgaben/steuer.md', set: { priority: 'hoch' }, remove: [] },
			{ type: 'frontmatter.patch', path: '10_Aufgaben/zahnarzt.md', set: { priority: 'mittel' }, remove: [] },
		]);
	});

	it('Quellbindung: halluzinierter Pfad ist ein Validierungsfehler', () => {
		const r = validateOutput(fixture('hallucinated-path.txt'), triage, sources, slugTables, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.some((e) => e.includes('erfunden.md'))).toBe(true);
	});

	it('unbekannter Slug ist ein Validierungsfehler', () => {
		const r = validateOutput(fixture('wrong-slug.txt'), triage, sources, slugTables, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.some((e) => e.includes('urgent'))).toBe(true);
	});

	it('lehnt Nicht-Objekte und fehlende items ab', () => {
		expect(validateOutput('```json\n[1,2]\n```', triage, sources, slugTables, null).ok).toBe(false);
		expect(validateOutput('```json\n{"foo": 1}\n```', triage, sources, slugTables, null).ok).toBe(false);
	});
});

describe('validateOutput mit briefing-v1', () => {
	it('erzeugt section.replace auf das expandierte Target', () => {
		const r = validateOutput('```json\n{"markdown": "## Heute\\n- Steuer"}\n```', briefing, [], {}, '70_Journal/2026-07-02.md');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.actions).toEqual([
			{ type: 'section.replace', path: '70_Journal/2026-07-02.md', content: '## Heute\n- Steuer' },
		]);
	});

	it('verlangt ein Target und einen Markdown-String', () => {
		expect(validateOutput('```json\n{"markdown": "x"}\n```', briefing, [], {}, null).ok).toBe(false);
		expect(validateOutput('```json\n{"markdown": 5}\n```', briefing, [], {}, 'a.md').ok).toBe(false);
	});
});

describe('buildRepairPrompt', () => {
	it('enthält Roh-Output und konkrete Fehlerliste', () => {
		const msgs = buildRepairPrompt('kaputt{', ['items: fehlt']);
		expect(msgs[0]?.role).toBe('system');
		expect(msgs[1]?.content).toContain('kaputt{');
		expect(msgs[1]?.content).toContain('items: fehlt');
		expect(msgs[1]?.content).toContain('NUR korrigiertes JSON');
	});
});
