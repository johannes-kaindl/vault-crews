/** Slug-Mapping (Spec §2.5.3): Das Modell sieht und produziert NUR ASCII-Slugs;
 *  der Executor mappt byte-genau auf die Original-Werte zurück. Kein Tokenizer-Roulette
 *  mit Emojis, keine hartkodierten Wertemengen — Tabellen entstehen pro Lauf aus Ist-Werten. */
import type { SlugTableData } from './types';

const ENUM_PATTERN = /^[^_\s]+_(.+)_[^\w\s]+$/u;

export function buildSlugTable(values: string[]): SlugTableData {
	const toSlug: Record<string, string> = {};
	const fromSlug: Record<string, string> = {};
	for (const value of values) {
		if (value === '' || value in toSlug) continue;
		const base = derive(value);
		if (base === '') continue;
		let slug = base;
		for (let n = 2; slug in fromSlug; n++) slug = `${base}-${n}`;
		toSlug[value] = slug;
		fromSlug[slug] = value;
	}
	return { toSlug, fromSlug };
}

function derive(value: string): string {
	const m = ENUM_PATTERN.exec(value);
	const core = m?.[1] ?? value;
	return core
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')          // Diakritika
		.replace(/[^\x20-\x7E]/g, '')             // alles Nicht-ASCII (Emoji etc.)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
