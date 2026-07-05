import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRepairPrompt, extractJson, extractText, validateOutput } from '../../src/core/output-validator';
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

describe('validateOutput mit briefing-v1 (RAW-TEXT, kein JSON)', () => {
	it('erzeugt section.replace auf das expandierte Target', () => {
		const r = validateOutput('## Heute\n- Steuer', briefing, [], {}, '70_Journal/2026-07-02.md');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.actions).toEqual([
			{ type: 'section.replace', path: '70_Journal/2026-07-02.md', content: '## Heute\n- Steuer' },
		]);
	});

	it('verlangt ein Target und nicht-leeren Text', () => {
		expect(validateOutput('x', briefing, [], {}, null).ok).toBe(false);
		expect(validateOutput('   \n  ', briefing, [], {}, 'a.md').ok).toBe(false);
	});

	it('lehnt zu lange Ausgaben ab (>16000 Zeichen)', () => {
		const tooLong = 'x'.repeat(16_001);
		const r = validateOutput(tooLong, briefing, [], {}, 'a.md');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.some((e) => e.includes('16000'))).toBe(true);
	});

	// Regression: qwen3.6 im Smoke-Test emittierte einen unescapten geraden Anführungsstrich
	// („aktiv" statt „aktiv\") innerhalb der JSON-markdown-Value — brach JSON.parse in
	// BEIDEN Original- und Repair-Calls (invalid_output). briefing-v1 ist jetzt RAW-TEXT:
	// dieselbe Ausgabe, roh statt JSON-gewrappt, validiert klaglos.
	it('regression: rohe Markdown-Antwort mit unescapten Anführungszeichen und echten Newlines validiert (der Smoke-Test-Bug)', () => {
		const raw = '## Heute fällig\n- Status „aktiv" ok\n\n## Überfällig\n- keine\n\n## Eine nächste Handlung\n- x';
		const r = validateOutput(raw, briefing, [], {}, '70_Journal/2026-07-02.md');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.actions).toEqual([
			{ type: 'section.replace', path: '70_Journal/2026-07-02.md', content: raw },
		]);
	});

	it('entfernt einen umschließenden ```markdown-Fence', () => {
		const raw = '```markdown\n## Heute\n- Steuer\n```';
		const r = validateOutput(raw, briefing, [], {}, 'a.md');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.actions).toEqual([{ type: 'section.replace', path: 'a.md', content: '## Heute\n- Steuer' }]);
	});

	it('entfernt <think>-Reste vor der Validierung', () => {
		const raw = '<think>ich überlege...</think>## Heute\n- Steuer';
		const r = validateOutput(raw, briefing, [], {}, 'a.md');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.actions).toEqual([{ type: 'section.replace', path: 'a.md', content: '## Heute\n- Steuer' }]);
	});
});

describe('extractText', () => {
	it('entfernt ``` / ```markdown / ```md-Fences, aber nur wenn sie den GESAMTEN Text umschließen', () => {
		expect(extractText('```markdown\nHallo\n```')).toBe('Hallo');
		expect(extractText('```md\nHallo\n```')).toBe('Hallo');
		expect(extractText('```\nHallo\n```')).toBe('Hallo');
		expect(extractText('Vorwort\n```markdown\nHallo\n```')).toBe('Vorwort\n```markdown\nHallo\n```');
	});
});

describe('buildRepairPrompt', () => {
	it('enthält Roh-Output und konkrete Fehlerliste, ist format-neutral (kein "JSON" im System-Text)', () => {
		const msgs = buildRepairPrompt('kaputt{', ['items: fehlt']);
		expect(msgs[0]?.role).toBe('system');
		expect(msgs[0]?.content).not.toContain('JSON');
		expect(msgs[1]?.content).toContain('kaputt{');
		expect(msgs[1]?.content).toContain('items: fehlt');
		expect(msgs[1]?.content).toContain('System-Prompt geforderten Format');
	});
});
