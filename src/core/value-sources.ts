/** Wertemengen aus dem Bestand (`values` an `frontmatter.set`): was ein Feld annehmen darf, wird vor dem Modellaufruf aus dem Vault
 *  gelesen (Tags, Namen von Notizen) oder aus der Crew-Datei genommen (feste Liste) und wie jede andere Wertemenge in Kurzformen
 *  (Slugs) übersetzt. Das Modell sieht nur die Kurzformen; der Executor mappt sie byte-genau zurück (Stufe 2). */
import { foldCase } from '../vendor/kit/fold-case';
import { wikilinkOf } from '../vendor/kit/frontmatter';
import { checkFixedFolder } from './paths';
import type { MetadataPort } from './ports';
import { NO_DESTINATION } from './schemas';
import { buildSlugTable } from './slug-mapper';
import type { Destination, OutputSpec, SlugTableData, TeamDef, ValueSource } from './types';

/** Obergrenze je Feld; was darüber liegt, wird gekürzt und in `notes` genannt (bei `list` lehnt schon der Parser ab). */
export const VALUES_MAX = 300;

/** Der Wikilink auf eine Notiz anhand ihres Namens (`Notiz.basename`, ohne Endung) oder `null`, wenn sich der Name nicht als Link schreiben lässt. Den Link baut das Kit (`wikilinkOf`: `[ ] # ^ |`,
 *  leerer Name; ein falscher Link ist schlimmer als ein fehlender Wert); die Endung `.md` kommt wieder an, damit ein Name, der selbst auf `.md` endet, ihn nicht verliert. Steuerzeichen
 *  im Namen lässt das Kit durch, hier nicht (die Prüfung gab es vorher, sie bleibt). */
function noteLink(name: string): string | null {
	if ([...name].some((c) => c.charCodeAt(0) < 32)) return null;
	return wikilinkOf(`${name}.md`);
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
		const link = noteLink(name);
		if (link === null) {
			notes.push(`${label}: „${name}“ fehlt in der Wertemenge, der Name lässt sich nicht als Wikilink schreiben (nicht erlaubt: [ ] # ^ | und Steuerzeichen, kein leerer Name)`);
			continue;
		}
		entries.push({ name, value: link });
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
		const toSlug: Record<string, string> = Object.create(null) as Record<string, string>;
		const fromSlug: Record<string, string> = Object.create(null) as Record<string, string>;
		const owner = new Map<string, string>();   // Kurzform → erster Name, der sie trägt
		for (const e of gathered.entries) {
			const slug = Object.hasOwn(byName.toSlug, e.name) ? byName.toSlug[e.name] : undefined;
			if (slug === undefined) {
				notes.push(`${label}: „${e.name}“ hat keine brauchbare Kurzform und fehlt in der Wertemenge`);
				continue;
			}
			if (Object.hasOwn(toSlug, e.value)) continue;   // derselbe Wert zweimal
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

/** Höchstzahl der Zielordner einer `note.file`-Liste (feste Ziele und Laufzeitziele zusammen). */
export const DESTINATIONS_FROM_MAX = 100;

/** Baut die fertige Zielliste für `note.file`: erst die festen Ziele der Crew-Datei, dann (bei `destinations_from`) die direkten Unterordner dieses Ordners,
 *  alphabetisch, ohne Doppelte (Groß-/Kleinschreibung gefaltet) und höchstens `DESTINATIONS_FROM_MAX` insgesamt. Ein Unterordner außerhalb von `write_scope`,
 *  auf der Sperrliste oder mit dem reservierten Namen `none` fällt weg und steht in `notes` (Klartext für `run.md`): wählte das Modell ihn, wäre die Aktion
 *  abgelehnt und zählte für die Konsistenz-Schwelle. */
export async function resolveDestinations(
	spec: Extract<OutputSpec, { family: 'note.file' }>,
	meta: MetadataPort,
	team: Pick<TeamDef, 'writeScope'>,
	denylist: string[],
): Promise<{ destinations: Destination[]; notes: string[] }> {
	const destinations: Destination[] = [...spec.destinations];
	const notes: string[] = [];
	const seen = new Set(destinations.map((d) => foldCase(d.folder)));
	if (spec.destinationsFrom !== null) {
		const eligible: string[] = [];
		for (const folder of await meta.listFolders(spec.destinationsFrom)) {
			const name = folder.slice(folder.lastIndexOf('/') + 1);
			if (foldCase(name) === NO_DESTINATION) {
				notes.push(`destinations_from: „${folder}“ fehlt in der Liste, der Name „${NO_DESTINATION}“ ist für „Notiz bleibt“ reserviert`);
				continue;
			}
			const problem = checkFixedFolder(folder, team, denylist);
			if (problem !== null) {
				notes.push(`destinations_from: ${problem}, der Ordner fehlt in der Liste`);
				continue;
			}
			if (seen.has(foldCase(folder))) continue;
			seen.add(foldCase(folder));
			eligible.push(folder);
		}
		const slots = Math.max(0, DESTINATIONS_FROM_MAX - destinations.length);
		if (eligible.length > slots) {
			notes.push(`destinations_from: ${slots} von ${eligible.length} Unterordnern (alphabetisch, höchstens ${DESTINATIONS_FROM_MAX} Ziele), der Rest fehlt in der Liste`);
		}
		for (const folder of eligible.slice(0, slots)) destinations.push({ folder, when: null });
	}
	if (destinations.length === 0) notes.push(`keine Zielordner gefunden, jede Antwort außer ${NO_DESTINATION} wird abgelehnt`);
	return { destinations, notes };
}
