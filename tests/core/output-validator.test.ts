import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripThinkBlocks } from '../../src/vendor/kit/think-splitter';
import { buildRepairPrompt, extractJson, extractText, validateOutput } from '../../src/core/output-validator';
import { pruefeLinear } from '../vendor/kit/linear-probe';
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

describe('extractJson: Verhalten aus dem Kit-Modul llm-json (Welle 18)', () => {
	const obj = '{"items":[]}';

	it('ein offenes <think> verwirft den Rest — ein JSON dahinter zählt nicht mehr (bewusste Änderung)', () => {
		const r = extractJson(`<think>ich überlege\n${obj}`);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('no JSON');
	});
	it('ein geschlossenes <think> davor stört nicht', () => {
		expect(extractJson(`<think>x</think>${obj}`).ok).toBe(true);
	});
	it('Prosa mit Klammern vor dem JSON wird übersprungen', () => {
		const r = extractJson(`Siehe [Quelle] und {nicht json}: ${obj}`);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.json).toEqual({ items: [] });
	});
	it('ein Fence auf einer Zeile ist kein Block; das JSON wird im Gesamttext gefunden', () => {
		const r = extractJson('```json ' + obj + '```');
		expect(r.ok).toBe(true);
	});
	it('mit mehreren json-Fences gilt der letzte', () => {
		const r = extractJson('```json\n{"items":[1]}\n```\nText\n```json\n{"items":[2]}\n```');
		expect(r.ok && (r.json as { items: number[] }).items[0]).toBe(2);
	});
	it('ungültiges JSON im Fence meldet den Parserfehler', () => {
		const r = extractJson('```json\n{"a": nope}\n```');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/^invalid JSON: /);
	});
});

describe('extractJson: linear bei entarteten Antworten (Welle 18, Messung statt Annahme)', () => {
	// Linearitätsprobe (Kit `pruefeLinear`: n = 1 000 / 10 000 / 50 000, Quotient statt Wanduhr-Grenze),
	// damit zwölf parallele Sessions den Test nicht kippen (Welle 20).
	it('Escape frisst die Anführungszeichen: \\"[ × n', () => {
		const r = pruefeLinear(extractJson, '\\"[');
		expect(r.linear, r.message).toBe(true);
	});
	it('verschachtelt und nie JSON: [ × n + x + ] × n', () => {
		const r = pruefeLinear(extractJson, (n: number) => '['.repeat(n) + 'x' + ']'.repeat(n));
		expect(r.linear, r.message).toBe(true);
	});
	it('viele kleine Klammerpaare ohne JSON: {] × n', () => {
		const r = pruefeLinear(extractJson, '{]');
		expect(r.linear, r.message).toBe(true);
	});
	it('ein nie geschlossener Fence: ```json × n', () => {
		const r = pruefeLinear(extractJson, '```json\n{"a":1');
		expect(r.linear, r.message).toBe(true);
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

// `extractText` ruft die Kit-Funktion `unwrapAnswer` (code-kit 0.38.0, `llm-answer`). Die alte Fassung steht hier als Referenz: gleich für jeden Zaun mit ``` / ```md / ```markdown
// (kleines Alphabet, Rümpfe bis vier Token, auch mit innerem Zaun, CRLF und Denkblock), abweichend nur dort, wo die Kit-Fassung die Frage anders stellt.
describe('extractText gegen die alte Fassung (Differentialtest)', () => {
	const alt = (raw: string): string => {
		const stripped = stripThinkBlocks(raw).trim();
		const m = /^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/.exec(stripped);
		return (m ? m[1] : stripped)?.trim() ?? '';
	};
	const alphabet = ['x', '\n', ' ', 'md', '```', '\r\n', '<think>a</think>'];
	const bodies = (maxTokens: number): string[] => {
		const out = [''];
		let layer = [''];
		for (let i = 0; i < maxTokens; i++) {
			layer = layer.flatMap((b) => alphabet.map((t) => b + t));
			out.push(...layer);
		}
		return out;
	};

	it('ist für Zäune mit ```, ```md und ```markdown gleich (alle Rümpfe bis vier Token, drei Schlussformen)', () => {
		const abweichend: string[] = [];
		let n = 0;
		for (const opener of ['```', '```md', '```markdown', '```md ']) {
			for (const body of bodies(4)) {
				for (const tail of ['\n```', '```', '\n```\n']) {
					const raw = `${opener}\n${body}${tail}`;
					n++;
					if (extractText(raw) !== alt(raw)) abweichend.push(JSON.stringify(raw));
				}
			}
		}
		expect(n).toBeGreaterThan(30_000);
		expect(abweichend.slice(0, 5)).toEqual([]);
	});

	it('ohne Zaun und mit einem Zaun mitten im Text bleibt der Text, wie er war', () => {
		for (const raw of ['Hallo', 'Vorwort\n```md\nHallo\n```', '```md\nHallo', 'Hallo\n```', '~~~md\nHallo\n~~~', '']) {
			expect(extractText(raw)).toBe(alt(raw));
		}
	});

	// Abweichung 1 (Verbesserung): der Tag eines anderen Zauns blieb früher als erste Zeile im Text stehen („```text\nHallo\n```“ gab „text\nHallo“).
	it('entfernt auch den Tag eines anderen Zauns, statt ihn als Text stehen zu lassen', () => {
		expect(alt('```text\nHallo\n```')).toBe('text\nHallo');
		expect(extractText('```text\nHallo\n```')).toBe('Hallo');
		expect(extractText('```MD\nHallo\n```')).toBe('Hallo');
		expect(extractText('```json\n{"a":1}\n```')).toBe('{"a":1}');
	});

	// Abweichung 2 (Verlust, bewusst in Kauf genommen): ein Zaun in EINER Zeile („```Hallo```“) wird von der Kit-Fassung nicht entzäunt; ein Modell tut das mit einer Markdown-Antwort kaum.
	it('entzäunt einen Zaun in einer einzigen Zeile nicht mehr', () => {
		expect(alt('```Hallo```')).toBe('Hallo');
		expect(extractText('```Hallo```')).toBe('```Hallo```');
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

describe('Think-Blöcke entfernen: linear in der Eingabelänge (Welle 17)', () => {
	it('offene <think> ohne Schluss wachsen linear (vorher 2,6 s bei 50 000, quadratisch)', () => {
		for (const f of [extractText, extractJson]) {
			const r = pruefeLinear(f, '<think>');
			expect(r.linear, r.message).toBe(true);
		}
	});

	it('Paare fallen weiterhin weg, ein offenes Ende bleibt stehen', () => {
		expect(extractText('<think>a</think>Hallo<think>b</think> Welt')).toBe('Hallo Welt');
		expect(extractText('Text <think>offen')).toBe('Text <think>offen');
	});
});
