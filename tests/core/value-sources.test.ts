import { describe, expect, it, vi } from 'vitest';
import type { MetadataPort } from '../../src/core/ports';
import { buildDenylist } from '../../src/core/paths';
import { DESTINATIONS_FROM_MAX, resolveDestinations, resolveValueTables, VALUES_MAX } from '../../src/core/value-sources';

interface Probe { tagCalls: number; noteCalls: { folder: string; limit: number }[] }

function meta(opts: { tags?: { tag: string; count: number }[]; notes?: string[]; folders?: Record<string, string[]> } = {}): { port: MetadataPort; probe: Probe } {
	const probe: Probe = { tagCalls: 0, noteCalls: [] };
	const port: MetadataPort = {
		listMarkdownFiles: async () => [],
		getFrontmatter: async () => null,
		getBody: async () => '',
		listTags: async () => { probe.tagCalls++; return opts.tags ?? []; },
		listFolders: async (parent) => opts.folders?.[parent] ?? [],
		recentNoteNames: async (folder, limit) => { probe.noteCalls.push({ folder, limit }); return (opts.notes ?? []).slice(0, limit); },
	};
	return { port, probe };
}

describe('resolveValueTables', () => {
	it('tags: liefert die Tags des Vaults als Wertemenge, die häufigsten zuerst gekappt', async () => {
		// Absichtlich in gemischter Reihenfolge: ohne Sortierung nach Anzahl fiele ein häufiger Tag der Kappung zum Opfer.
		const all = Array.from({ length: 301 }, (_, i) => ({ tag: `t${i}`, count: 301 - i }));
		const shuffled = [...all.slice(150), ...all.slice(0, 150)].reverse();
		const r = await resolveValueTables({ tags: { kind: 'tags' } }, meta({ tags: shuffled }).port);
		expect(Object.keys(r.tables.tags?.fromSlug ?? {})).toHaveLength(VALUES_MAX);
		expect(r.tables.tags?.fromSlug.t0).toBe('t0');
		expect(r.tables.tags?.fromSlug.t300).toBeUndefined();
		expect(r.notes.join('\n')).toMatch(/tags.*300 von 301/);
	});

	it('tags: bei gleicher Anzahl entscheidet die alphabetische Reihenfolge', async () => {
		const tags = ['c', 'a', 'b', 'd'].map((tag) => ({ tag, count: 2 }));
		const r = await resolveValueTables({ tags: { kind: 'tags' } }, meta({ tags: [...tags, { tag: 'z', count: 9 }] }).port);
		expect(Object.keys(r.tables.tags?.fromSlug ?? {})).toEqual(['z', 'a', 'b', 'c', 'd']);
	});

	it('tags: ein Tag mit Schrägstrich bekommt eine Kurzform und mappt auf das Original zurück', async () => {
		const r = await resolveValueTables({ tags: { kind: 'tags' } }, meta({ tags: [{ tag: 'projekt/alpha', count: 1 }] }).port);
		expect(r.tables.tags?.fromSlug['projekt-alpha']).toBe('projekt/alpha');
		expect(r.tables.tags?.toSlug['projekt/alpha']).toBe('projekt-alpha');
		expect(r.notes).toEqual([]);
	});

	it('notes: bildet Kurzform auf einen Wikilink ab', async () => {
		const m = meta({ notes: ['Meyer GmbH'] });
		const r = await resolveValueTables({ projekt: { kind: 'notes', folder: '40_Projekte' } }, m.port);
		expect(r.tables.projekt?.fromSlug['meyer-gmbh']).toBe('[[Meyer GmbH]]');
		expect(r.tables.projekt?.toSlug['[[Meyer GmbH]]']).toBe('meyer-gmbh');
		expect(m.probe.noteCalls).toEqual([{ folder: '40_Projekte', limit: VALUES_MAX + 1 }]);
	});

	it('notes: bei mehr als 300 Notizen kommen 300 und der Hinweis, dass es weitere gibt', async () => {
		const names = Array.from({ length: 305 }, (_, i) => `Notiz ${i}`);
		const r = await resolveValueTables({ projekt: { kind: 'notes', folder: 'P' } }, meta({ notes: names }).port);
		expect(Object.keys(r.tables.projekt?.fromSlug ?? {})).toHaveLength(VALUES_MAX);
		expect(r.notes.join('\n')).toMatch(/projekt.*300.*zuletzt geänderten.*weitere/);
	});

	it.each([['A [x]'], ['A#b'], ['A^b'], ['A|b'], ['A]b']])('notes: lässt den Namen %j mit Grund aus, statt einen falschen Link zu bauen', async (name) => {
		const r = await resolveValueTables({ projekt: { kind: 'notes', folder: 'P' } }, meta({ notes: [name, 'Gut'] }).port);
		expect(Object.values(r.tables.projekt?.fromSlug ?? {})).toEqual(['[[Gut]]']);
		expect(r.notes.join('\n')).toContain(name);
		expect(r.notes.join('\n')).toMatch(/Wikilink|Link/);
	});

	it('notes: der Link kommt aus dem Kit (wikilinkOf), ein Name auf .md behält seine Endung, ein leerer Name oder ein Steuerzeichen fällt mit Grund aus', async () => {
		const r = await resolveValueTables({ projekt: { kind: 'notes', folder: 'P' } }, meta({ notes: ['Report.md', 'Gut', '', 'A\u0001B'] }).port);
		expect(Object.values(r.tables.projekt?.fromSlug ?? {}).sort()).toEqual(['[[Gut]]', '[[Report.md]]']);
		const text = r.notes.join('\n');
		expect(text).toContain('A\u0001B');
		expect(text).toMatch(/„“ fehlt/);
		for (const name of ['', 'A\u0001B']) expect(text).toContain(`„${name}“ fehlt in der Wertemenge, der Name lässt sich nicht als Wikilink schreiben`);
	});

	it('list: nimmt die feste Liste', async () => {
		const r = await resolveValueTables({ type: { kind: 'list', list: ['Notiz', 'Aufgabe'] } }, meta().port);
		expect(Object.keys(r.tables.type?.fromSlug ?? {}).sort()).toEqual(['aufgabe', 'notiz']);
		expect(r.tables.type?.fromSlug.notiz).toBe('Notiz');
	});

	it('nennt einen Wert ohne brauchbare Kurzform, statt ihn still fallen zu lassen', async () => {
		const r = await resolveValueTables({ type: { kind: 'list', list: ['🙂', 'Notiz'] } }, meta().port);
		expect(Object.values(r.tables.type?.fromSlug ?? {})).toEqual(['Notiz']);
		expect(r.notes.join('\n')).toContain('🙂');
		expect(r.notes.join('\n')).toMatch(/type.*Kurzform/);
	});

	it('nennt Werte mit gleicher Kurzform und behält beide unter verschiedenen Kurzformen', async () => {
		const r = await resolveValueTables({ type: { kind: 'list', list: ['Büro', 'Buro'] } }, meta().port);
		expect(Object.values(r.tables.type?.fromSlug ?? {}).sort()).toEqual(['Buro', 'Büro']);
		const text = r.notes.join('\n');
		expect(text).toMatch(/type/);
		expect(text).toContain('Buro');
		expect(text).toContain('Büro');
		expect(text).toMatch(/gleiche Kurzform/);
	});

	it('eine leere Wertemenge wird genannt', async () => {
		const r = await resolveValueTables({ tags: { kind: 'tags' } }, meta({ tags: [] }).port);
		expect(r.tables.tags).toEqual({ toSlug: {}, fromSlug: {} });
		expect(r.notes.join('\n')).toMatch(/tags.*keine/);
	});

	it('ohne values wird nichts abgefragt', async () => {
		const m = meta();
		const r = await resolveValueTables({}, m.port);
		expect(r).toEqual({ tables: {}, notes: [] });
		expect(m.probe.tagCalls).toBe(0);
		expect(m.probe.noteCalls).toEqual([]);
	});

	it('ein Tag namens constructor oder __proto__ bleibt in der Wertemenge (kein Treffer auf Object.prototype)', async () => {
		const r = await resolveValueTables({ tags: { kind: 'tags' } }, meta({ tags: [{ tag: 'constructor', count: 2 }, { tag: '__proto__', count: 1 }, { tag: 'toString', count: 1 }] }).port);
		const t = r.tables.tags;
		expect(Object.hasOwn(t?.toSlug ?? {}, 'constructor')).toBe(true);
		expect(Object.hasOwn(t?.fromSlug ?? {}, 'constructor')).toBe(true);
		expect(Object.hasOwn(t?.toSlug ?? {}, '__proto__')).toBe(true);
		expect(Object.hasOwn(t?.toSlug ?? {}, 'toString')).toBe(true);
		expect(Object.values(t?.fromSlug ?? {}).sort()).toEqual(['__proto__', 'constructor', 'toString']);
		expect(r.notes).toEqual([]);
	});
});

describe('resolveDestinations', () => {
	const deny = buildDenylist('.obsidian', '_crews');
	const team = { writeScope: ['40_Projekte/**', '00_Inbox/**'] };
	const spec = (over: { destinations?: { folder: string; when: string | null }[]; from?: string | null } = {}) =>
		({ family: 'note.file' as const, destinations: over.destinations ?? [], destinationsFrom: over.from === undefined ? '40_Projekte' : over.from });
	const folders = (...names: string[]) => ({ '40_Projekte': names.map((n) => `40_Projekte/${n}`) });

	it('feste Ziele zuerst, dann die Unterordner in der Reihenfolge von listFolders, ohne Doppelte (gefaltet)', async () => {
		const r = await resolveDestinations(
			spec({ destinations: [{ folder: '40_Projekte/Zeta', when: 'Z' }] }), meta({ folders: folders('Alpha', 'zeta', 'Beta') }).port, team, deny);
		expect(r.destinations).toEqual([
			{ folder: '40_Projekte/Zeta', when: 'Z' }, { folder: '40_Projekte/Alpha', when: null }, { folder: '40_Projekte/Beta', when: null },
		]);
		expect(r.notes).toEqual([]);
	});

	it('lässt Ordner außerhalb write_scope, auf der Sperrliste und den Namen none weg und nennt sie', async () => {
		const r = await resolveDestinations(
			spec(), meta({ folders: folders('Meyer', '.versteckt', 'none', 'None') }).port, { writeScope: ['40_Projekte/Meyer/**', '40_Projekte/.versteckt/**', '40_Projekte/none/**', '40_Projekte/None/**'] }, deny);
		expect(r.destinations.map((d) => d.folder)).toEqual(['40_Projekte/Meyer']);
		const text = r.notes.join('\n');
		expect(text).toMatch(/\.versteckt.*geschützten Bereich/);
		expect(text).toMatch(/„40_Projekte\/none“.*reserviert/);
		expect(text).toMatch(/„40_Projekte\/None“.*reserviert/);
		const outside = await resolveDestinations(spec(), meta({ folders: folders('Meyer', 'Privat') }).port, { writeScope: ['40_Projekte/Meyer/**'] }, deny);
		expect(outside.destinations.map((d) => d.folder)).toEqual(['40_Projekte/Meyer']);
		expect(outside.notes.join('\n')).toMatch(/Privat.*write_scope/);
	});

	it(`kappt feste und Laufzeitziele zusammen auf ${DESTINATIONS_FROM_MAX} und nennt die Kürzung`, async () => {
		const many = Array.from({ length: 120 }, (_, i) => `f${String(i).padStart(3, '0')}`);
		const fixed = [{ folder: '40_Projekte/fest', when: null }];
		const r = await resolveDestinations(spec({ destinations: fixed }), meta({ folders: folders(...many) }).port, team, deny);
		expect(r.destinations).toHaveLength(DESTINATIONS_FROM_MAX);
		expect(r.destinations[0]?.folder).toBe('40_Projekte/fest');
		expect(r.destinations.at(-1)?.folder).toBe('40_Projekte/f098');
		expect(r.notes.join('\n')).toMatch(/99 von 120/);
	});

	it('ohne destinations_from ruft es listFolders nicht; eine leere Liste wird gemeldet', async () => {
		const m = meta({ folders: folders('Meyer') });
		const spy = vi.spyOn(m.port, 'listFolders');
		const r = await resolveDestinations(spec({ from: null }), m.port, team, deny);
		expect(spy).not.toHaveBeenCalled();
		expect(r.destinations).toEqual([]);
		expect(r.notes.join('\n')).toMatch(/keine Zielordner/);
	});
});

