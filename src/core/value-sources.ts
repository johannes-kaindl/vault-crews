/** Wertemengen aus dem Bestand (`values` an `frontmatter.set`): was ein Feld annehmen darf, wird vor dem Modellaufruf aus dem Vault
 *  gelesen (Tags, Namen von Notizen) oder aus der Crew-Datei genommen (feste Liste) und wie jede andere Wertemenge in Kurzformen
 *  (Slugs) übersetzt. Das Modell sieht nur die Kurzformen; der Executor mappt sie byte-genau zurück (Stufe 2). */
import type { MetadataPort } from './ports';
import { buildSlugTable } from './slug-mapper';
import type { SlugTableData, ValueSource } from './types';

/** Obergrenze je Feld; was darüber liegt, wird gekürzt und in `notes` genannt (bei `list` lehnt schon der Parser ab). */
export const VALUES_MAX = 300;

/** Zeichen, die in einem Wikilink nicht vorkommen dürfen (`[[Name]]` brächte einen falschen oder gar keinen Link). */
const LINK_BREAKERS = /[[\]#^|]/;

function breaksLink(name: string): boolean {
	return LINK_BREAKERS.test(name) || [...name].some((c) => c.charCodeAt(0) < 32);
}

interface Entry { name: string; value: string; }
interface Gathered { entries: Entry[]; notes: string[]; }

async function gather(key: string, src: ValueSource, meta: MetadataPort): Promise<Gathered> {
	const label = `values.${key}`;
	const notes: string[] = [];
	if (src.kind === 'list') {
		if (src.list.length > VALUES_MAX) notes.push(`${label}: ${VALUES_MAX} von ${src.list.length} Werten, der Rest fehlt in der Wertemenge`);
		return { entries: src.list.slice(0, VALUES_MAX).map((v) => ({ name: v, value: v })), notes };
	}
	if (src.kind === 'tags') {
		const all = await meta.listTags();
		// Häufigste zuerst, bei Gleichstand alphabetisch: die Kürzung trifft die seltenen Tags und ist bei jedem Lauf dieselbe.
		const sorted = [...all].sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
		if (sorted.length > VALUES_MAX) notes.push(`${label}: ${VALUES_MAX} von ${sorted.length} Tags (die häufigsten zuerst), der Rest fehlt in der Wertemenge`);
		return { entries: sorted.slice(0, VALUES_MAX).map((t) => ({ name: t.tag, value: t.tag })), notes };
	}
	// limit + 1: kommt mehr zurück als erlaubt, ist die Kürzung erkennbar.
	const names = await meta.recentNoteNames(src.folder, VALUES_MAX + 1);
	if (names.length > VALUES_MAX) {
		notes.push(`${label}: die ${VALUES_MAX} zuletzt geänderten Notizen aus „${src.folder}“; es gibt weitere, sie fehlen in der Wertemenge`);
	}
	const entries: Entry[] = [];
	for (const name of names.slice(0, VALUES_MAX)) {
		if (breaksLink(name)) {
			notes.push(`${label}: „${name}“ fehlt in der Wertemenge, der Name enthält ein Zeichen, das in einem Wikilink nicht vorkommen darf ([ ] # ^ |)`);
			continue;
		}
		entries.push({ name, value: `[[${name}]]` });
	}
	return { entries, notes };
}

/** Baut je Feld die Slug-Tabelle der Wertemenge. `tables[key].fromSlug` führt von der Kurzform zum gespeicherten Wert (bei `notes` der
 *  fertige Wikilink). `notes` sind Klartextzeilen für `run.md`: Kürzung, Werte ohne Kurzform, Werte mit gleicher Kurzform, leere Menge. */
export async function resolveValueTables(
	values: Record<string, ValueSource>,
	meta: MetadataPort,
): Promise<{ tables: Record<string, SlugTableData>; notes: string[] }> {
	const tables: Record<string, SlugTableData> = {};
	const notes: string[] = [];
	for (const [key, src] of Object.entries(values)) {
		const label = `values.${key}`;
		const gathered = await gather(key, src, meta);
		notes.push(...gathered.notes);

		const byName = buildSlugTable(gathered.entries.map((e) => e.name));
		const toSlug: Record<string, string> = {};
		const fromSlug: Record<string, string> = {};
		const owner = new Map<string, string>();   // Kurzform → erster Name, der sie trägt
		for (const e of gathered.entries) {
			const slug = byName.toSlug[e.name];
			if (slug === undefined) {
				notes.push(`${label}: „${e.name}“ hat keine brauchbare Kurzform und fehlt in der Wertemenge`);
				continue;
			}
			if (e.value in toSlug) continue;   // derselbe Wert zweimal
			toSlug[e.value] = slug;
			fromSlug[slug] = e.value;
			if (!owner.has(slug)) owner.set(slug, e.name);
			// Die Kurzform allein (ohne Zähler) zeigt, ob dieser Wert sie mit einem früheren teilen müsste.
			const base = buildSlugTable([e.name]).toSlug[e.name];
			if (base !== undefined && base !== slug) {
				notes.push(`${label}: „${e.name}“ hat die gleiche Kurzform wie „${owner.get(base) ?? base}“ (${base}) und heißt für das Modell ${slug}`);
			}
		}
		if (Object.keys(fromSlug).length === 0) {
			notes.push(`${label}: keine Werte gefunden, jede Antwort für dieses Feld wird abgelehnt`);
		}
		tables[key] = { toSlug, fromSlug };
	}
	return { tables, notes };
}
