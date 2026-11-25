/**
 * Linearität der Funktionen, die fremden Modelltext zerlegen (ReDoS-Konvention, CORE-TEST-26 (b)): der erschöpfende Fuzz `pruefeLinearFuzz` aus dem Kit-Testmodul.
 * Gemessen wird ein Quotient t(50 000)/t(10 000), keine Millisekunden.
 *
 * Geprüft sind die beiden Wege, auf denen eine Modellantwort ankommt: `extractJson` (Zäune, Klammern, Escapes, Denkblöcke) und `extractText`
 * (umschließender Zaun, Denkblock). Die handgewählten Eingaben stehen in `output-validator.test.ts`; dieser Test ergänzt sie um alle Einheiten bis drei Alphabet-Einträge.
 *
 * Die Gegenprobe (eine absichtlich quadratische Fassung wird rot) steht am Ende dieser Datei.
 */
import { describe, expect, it } from 'vitest';
import { mitLastSchutz, pruefeLinearFuzz, type LinearProbeSkipKontext } from '../vendor/kit/linear-probe';
import { extractJson, extractText } from '../../src/core/output-validator';

const FUZZ_MS = 180_000;

/** Befund als lesbarer Text, damit eine rote Zeile ohne Nachlesen verständlich ist (CORE-TEST-14). */
const befund = (r: { verdaechtig: ReadonlyArray<{ message: string }> }): string => r.verdaechtig.map((v) => v.message).join('\n');

function fuzz(ctx: LinearProbeSkipKontext, fn: (s: string) => unknown, alphabet: string[]): void {
	const f = mitLastSchutz(ctx, () => pruefeLinearFuzz(fn, { alphabet, maxLaenge: 3 }));
	expect(f.linear, befund(f)).toBe(true);
	expect(f.gemessen, 'der Fuzz hat Eingaben gemessen').toBeGreaterThan(20);
}

describe('Modellantwort zerlegen', () => {
	it('extractJson: Fuzz über Klammern, Anführungszeichen, Escape und json-Zaun', (ctx) => {
		fuzz(ctx, (s) => extractJson(s), ['[', ']', '{', '"', '\\', '```json\n']);
	}, FUZZ_MS);

	it('extractText: Fuzz über Zaun, Denkblock und Zeilenumbruch', (ctx) => {
		fuzz(ctx, (s) => extractText(s), ['```\n', '```text\n', '<think>', '</think>', '\n', 'x']);
	}, FUZZ_MS);
});

describe('Gegenprobe: der Fuzz kann rot werden (CORE-TEST-01)', () => {
	/** Absichtlich quadratisch: dieselbe Form wie `text.replace(/\n*$/, …)` auf einer langen Folge von Zeilenumbrüchen. */
	const quadratisch = (s: string): string => s.replace(/\n*$/, '\n\n');

	it('pruefeLinearFuzz meldet die quadratische Form als Verdacht', (ctx) => {
		const f = mitLastSchutz(ctx, () => pruefeLinearFuzz((s) => quadratisch(`Rumpf\n${s}\nSchluss`), { alphabet: ['\n', 'x'], maxLaenge: 1, verschachtelt: false }));
		expect(f.linear).toBe(false);
		expect(f.verdaechtig.map((v) => v.einheit)).toContain('\n');
	}, FUZZ_MS);
});
