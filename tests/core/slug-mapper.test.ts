import { describe, expect, it } from 'vitest';
import { buildSlugTable } from '../../src/core/slug-mapper';

describe('buildSlugTable', () => {
	it('extrahiert den Mittelteil aus <nr>_<wort>_<emoji>-Mustern', () => {
		const t = buildSlugTable(['1_backlog_📥', '2_mittel_🟡', '6_erledigt_✅']);
		expect(t.toSlug['1_backlog_📥']).toBe('backlog');
		expect(t.toSlug['2_mittel_🟡']).toBe('mittel');
		expect(t.toSlug['6_erledigt_✅']).toBe('erledigt');
		expect(t.fromSlug.backlog).toBe('1_backlog_📥');
	});

	it('normalisiert freie Werte (Diakritika, Emoji, Spaces, Case)', () => {
		const t = buildSlugTable(['Später ⏳', 'Büro Arbeit']);
		expect(t.toSlug['Später ⏳']).toBe('spater');
		expect(t.toSlug['Büro Arbeit']).toBe('buro-arbeit');
	});

	it('löst Kollisionen deterministisch mit Suffixen', () => {
		const t = buildSlugTable(['x_a_📥', 'y_a_📦']);
		expect(t.toSlug['x_a_📥']).toBe('a');
		expect(t.toSlug['y_a_📦']).toBe('a-2');
		expect(t.fromSlug.a).toBe('x_a_📥');
		expect(t.fromSlug['a-2']).toBe('y_a_📦');
	});

	it('roundtrip: fromSlug[toSlug[v]] === v für alle Eingaben', () => {
		const values = ['1_backlog_📥', '2_mittel_🟡', 'Später ⏳', 'x_a_📥', 'y_a_📦', 'plain'];
		const t = buildSlugTable(values);
		for (const v of values) {
			const slug = t.toSlug[v];
			expect(slug, v).toBeTruthy();
			expect(t.fromSlug[slug ?? '']).toBe(v);
		}
	});

	it('ignoriert Duplikate und Nicht-String-taugliche leere Werte', () => {
		const t = buildSlugTable(['a', 'a', '']);
		expect(Object.keys(t.toSlug)).toEqual(['a']);
	});
});
