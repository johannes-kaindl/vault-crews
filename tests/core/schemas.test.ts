import { describe, expect, it } from 'vitest';
import { BUILTIN_SCHEMAS, buildSchema, makeFrontmatterSet, makeNotesCreate, makeSectionWrite, makeTextAppend } from '../../src/core/schemas';
import type { SchemaRuntime } from '../../src/core/schemas';
import type { CollectedFile, OutputSpec, SlugTableData } from '../../src/core/types';

const sources: CollectedFile[] = [
	{ path: '10_Aufgaben/a.md', contentHash: 'h', frontmatter: null, content: null },
];
const noSlugs: Record<string, SlugTableData> = {};

describe('makeFrontmatterSet', () => {
	it('accepts a key listed in allowedKeys', () => {
		const schema = makeFrontmatterSet(['tags']);
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { tags: 'x' } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.actions).toEqual([{ type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { tags: 'x' }, remove: [] }]);
	});

	it('rejects a key NOT in allowedKeys', () => {
		const schema = makeFrontmatterSet(['tags']);
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { prioritaet: 'hoch' } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/prioritaet.*allowed_keys/);
	});

	it("wildcard '*' allows any key (triage-v1 legacy behaviour)", () => {
		const schema = makeFrontmatterSet('*');
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { beliebig: 1 } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(true);
	});

	it('still enforces source-binding regardless of allowedKeys', () => {
		const schema = makeFrontmatterSet('*');
		const r = schema.validate({ items: [{ path: 'fremd/x.md', set: { tags: 'x' } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/Quellbindung/);
	});

	it('accepts a string list value', () => {
		const schema = makeFrontmatterSet(['tags']);
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { tags: ['arbeit', 'notiz'] } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.actions).toEqual([{ type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { tags: ['arbeit', 'notiz'] }, remove: [] }]);
	});

	it('rejects a non-scalar list element (null)', () => {
		const schema = makeFrontmatterSet(['tags']);
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { tags: ['ok', null] } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/Listen-Element/);
	});

	it('enforces slug-enum per list element', () => {
		const slugs = { status: { toSlug: { '1_offen 📥': 'offen' }, fromSlug: { offen: '1_offen 📥' } } };
		const schema = makeFrontmatterSet(['status']);
		const ok = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { status: ['offen'] } }] }, sources, slugs, null);
		expect(ok.ok).toBe(true);
		const bad = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { status: ['offen', 'quatsch'] } }] }, sources, slugs, null);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors.join('\n')).toMatch(/quatsch/);
	});
});

describe('makeSectionWrite', () => {
	it('produces one section.replace into target', () => {
		const schema = makeSectionWrite(16000, 'briefing');
		const r = schema.validate('# Hallo', sources, noSlugs, '30_Chronos/heute.md');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.actions).toEqual([{ type: 'section.replace', path: '30_Chronos/heute.md', content: '# Hallo' }]);
	});

	it('rejects text over maxChars', () => {
		const schema = makeSectionWrite(5, 'briefing');
		const r = schema.validate('123456', sources, noSlugs, '30_Chronos/heute.md');
		expect(r.ok).toBe(false);
	});
});

describe('makeFrontmatterSet — add_to', () => {
	const path = '10_Aufgaben/a.md';
	const tagTable = { tags: { toSlug: { 'projekt/alpha': 'projekt-alpha', neu: 'neu' }, fromSlug: { 'projekt-alpha': 'projekt/alpha', neu: 'neu' } } };

	it('ein Listenwert eines add_to-Feldes wandert nach add statt nach set', () => {
		const r = makeFrontmatterSet(['tags', 'priority'], ['tags']).validate(
			{ items: [{ path, set: { tags: ['a', 'b'], priority: 'mittel' } }] }, sources, noSlugs, null,
		);
		expect(r).toEqual({ ok: true, actions: [{ type: 'frontmatter.patch', path, set: { priority: 'mittel' }, remove: [], add: { tags: ['a', 'b'] } }] });
	});

	it('ein Einzelwert eines add_to-Feldes wird eine einelementige Liste', () => {
		const r = makeFrontmatterSet(['tags'], ['tags']).validate({ items: [{ path, set: { tags: 'a' } }] }, sources, noSlugs, null);
		expect(r).toEqual({ ok: true, actions: [{ type: 'frontmatter.patch', path, set: {}, remove: [], add: { tags: ['a'] } }] });
	});

	it('Gegenprobe: ohne add_to ersetzt das Feld wie bisher (set, kein add)', () => {
		const r = makeFrontmatterSet(['tags']).validate({ items: [{ path, set: { tags: ['a'] } }] }, sources, noSlugs, null);
		expect(r).toEqual({ ok: true, actions: [{ type: 'frontmatter.patch', path, set: { tags: ['a'] }, remove: [] }] });
		const leer = makeFrontmatterSet(['tags'], []).validate({ items: [{ path, set: { tags: ['a'] } }] }, sources, noSlugs, null);
		expect(leer).toEqual(r);
	});

	it('ein Tag, den es im Vault nicht gibt, wird abgelehnt (auch als Einzelwert)', () => {
		const schema = makeFrontmatterSet(['tags'], ['tags']);
		for (const wert of [['erfunden'], ['neu', 'erfunden'], 'erfunden']) {
			const r = schema.validate({ items: [{ path, set: { tags: wert } }] }, sources, tagTable, null);
			expect(r.ok, JSON.stringify(wert)).toBe(false);
			if (!r.ok) expect(r.errors.join('\n')).toMatch(/erfunden.*kein erlaubter Wert/);
		}
		const ok = schema.validate({ items: [{ path, set: { tags: ['projekt-alpha'] } }] }, sources, tagTable, null);
		expect(ok.ok).toBe(true);
	});

	it('ein add_to-Feld mit null ist unzulässig', () => {
		const r = makeFrontmatterSet(['tags'], ['tags']).validate({ items: [{ path, set: { tags: null } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/tags/);
	});
});

describe('buildSchema', () => {
	it('reicht add_to an frontmatter.set weiter', () => {
		const r = buildSchema({ family: 'frontmatter.set', allowedKeys: ['tags'], values: {}, addTo: ['tags'] })
			.validate({ items: [{ path: '10_Aufgaben/a.md', set: { tags: ['x'] } }] }, sources, noSlugs, null);
		expect(r.ok && r.actions[0]).toMatchObject({ add: { tags: ['x'] } });
	});
	it('dispatches frontmatter.set', () => {
		expect(buildSchema({ family: 'frontmatter.set', allowedKeys: ['tags'], values: {}, addTo: [] }).outputFormat).toBe('json');
	});
	it('dispatches section.write', () => {
		expect(buildSchema({ family: 'section.write', maxChars: 16000, wording: 'briefing' }).outputFormat).toBe('text');
	});
	it('dispatches text.append', () => {
		expect(buildSchema({ family: 'text.append', maxChars: 4000, heading: null }).outputFormat).toBe('text');
	});
});

describe('Wortlaut von section.write', () => {
	it('briefing-v1 behält Wortlaut und Beispiel byte-genau', () => {
		expect(BUILTIN_SCHEMAS['briefing-v1'].promptContract).toBe(
			'Antworte ausschließlich mit dem fertigen Briefing als Markdown-Text — kein JSON, keine Code-Fence, keine Erklärungen davor oder danach.',
		);
		expect(BUILTIN_SCHEMAS['briefing-v1'].outputExample).toBe('## Heute fällig\n- Beispiel-Aufgabe\n\n## Überfällig\n- …\n\n## Eine nächste Handlung\n- …');
	});

	it('neutral: kein Briefing im Vertrag und im Beispiel', () => {
		const s = buildSchema({ family: 'section.write', maxChars: 16000, wording: 'neutral' });
		expect(s.promptContract).toBe(
			'Antworte ausschließlich mit dem fertigen Abschnitt als Markdown-Text — kein JSON, keine Code-Fence, keine Erklärungen davor oder danach.',
		);
		expect(s.outputExample).toBe('## Zusammenfassung\n- Kernaussage eins\n- Kernaussage zwei');
		expect(s.promptContract).not.toContain('Briefing');
		expect(s.outputExample).not.toMatch(/Heute|Überfällig|Briefing/);
	});

	it('neutral validiert wie briefing (eine section.replace am Ziel)', () => {
		const r = makeSectionWrite(100, 'neutral').validate('## A\n- b', sources, noSlugs, 'n/a.md');
		expect(r).toEqual({ ok: true, actions: [{ type: 'section.replace', path: 'n/a.md', content: '## A\n- b' }] });
	});
});

describe('makeTextAppend', () => {
	it('erzeugt note.append am Ziel mit Überschrift', () => {
		const r = makeTextAppend(4000, 'Verlauf').validate('Zeile', sources, noSlugs, 'Log/2026.md');
		expect(r).toEqual({ ok: true, actions: [{ type: 'note.append', path: 'Log/2026.md', heading: 'Verlauf', content: 'Zeile' }] });
	});

	it('ohne Überschrift: heading null', () => {
		const r = makeTextAppend(4000, null).validate(' Zeile \n', sources, noSlugs, 'Log/2026.md');
		expect(r).toEqual({ ok: true, actions: [{ type: 'note.append', path: 'Log/2026.md', heading: null, content: 'Zeile' }] });
	});

	it('lehnt leeren Text, Text über maxChars und fehlendes Ziel ab', () => {
		expect(makeTextAppend(4000, null).validate('  ', sources, noSlugs, 'a.md').ok).toBe(false);
		expect(makeTextAppend(5, null).validate('123456', sources, noSlugs, 'a.md').ok).toBe(false);
		const noTarget = makeTextAppend(4000, null).validate('x', sources, noSlugs, null);
		expect(noTarget.ok).toBe(false);
		if (!noTarget.ok) expect(noTarget.errors.join('\n')).toMatch(/target/);
	});

	it('Vertrag nennt den angehängten Text, nicht den fertigen Abschnitt', () => {
		const s = makeTextAppend(4000, null);
		expect(s.promptContract).toBe(
			'Antworte ausschließlich mit dem Text, der angehängt wird, als Markdown-Text — kein JSON, keine Code-Fence, keine Erklärungen davor oder danach.',
		);
		expect(s.outputExample).toBe('## Zusammenfassung\n- Kernaussage eins\n- Kernaussage zwei');
	});
});

describe('makeNotesCreate', () => {
	const rt: SchemaRuntime = { nowMs: Date.UTC(2026, 10, 14, 12), notePath: '00_Inbox/t.md', destinations: [] };
	type NotesCreateSpec = Extract<OutputSpec, { family: 'notes.create' }>;
	const spec: NotesCreateSpec = {
		family: 'notes.create', folder: '10_Aufgaben', maxItems: 5,
		frontmatter: { type: '💪 Aufgabe', status: 'backlog' }, linkSource: 'quelle',
	};
	const run = (items: unknown[], s: NotesCreateSpec = spec, r: SchemaRuntime = rt) =>
		makeNotesCreate(s, r).validate({ items }, sources, noSlugs, null);
	const created = (items: unknown[], s: NotesCreateSpec = spec, r: SchemaRuntime = rt): { path: string; content: string }[] => {
		const res = run(items, s, r);
		if (!res.ok) throw new Error(res.errors.join('; '));
		return res.actions.map((a) => {
			if (a.type !== 'note.create') throw new Error('keine note.create');
			return { path: a.path, content: a.content };
		});
	};

	it('baut Pfad aus festem Ordner und Titel, Inhalt aus festem Frontmatter, Quelle und Text', () => {
		const r = run([{ title: 'Angebot schicken', body: 'Bis Freitag.' }]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.actions[0]).toMatchObject({ type: 'note.create', path: '10_Aufgaben/Angebot schicken.md' });
		const content = (r.actions[0] as { content: string }).content;
		expect(content.startsWith('---\n')).toBe(true);
		expect(content).toContain('status: backlog');
		// Pfadlink, eindeutig auch bei gleichnamigen Notizen; im Frontmatter quotiert.
		expect(content).toContain('[[00_Inbox/t]]');
		expect(content).not.toContain('[[t]]');
		expect(content.trimEnd().endsWith('Bis Freitag.')).toBe(true);
	});

	it('schreibt Frontmatter in der Reihenfolge der Crew-Datei, die Quelle zuletzt', () => {
		const [note] = created([{ title: 'A', body: 'x' }]);
		const fm = (note?.content ?? '').split('---\n')[1] ?? '';
		expect(fm.split('\n').map((l) => l.split(':')[0])).toEqual(['type', 'status', 'quelle', '']);
	});

	it('ohne link_source steht keine Quelle im Frontmatter', () => {
		const [note] = created([{ title: 'A', body: 'x' }], { ...spec, linkSource: null });
		expect(note?.content).not.toContain('quelle');
		expect(note?.content).not.toContain('[[');
	});

	it('ein Quellpfad, der sich nicht als Link schreiben lässt, steht als Text', () => {
		const [note] = created([{ title: 'A', body: 'x' }], spec, { ...rt, notePath: '00_Inbox/Was #1.md' });
		expect(note?.content).toContain('00_Inbox/Was #1.md');
		expect(note?.content).not.toContain('[[');
	});

	it('ohne Quellnotiz (kein per_note) entfällt der Quell-Link', () => {
		const [note] = created([{ title: 'A', body: 'x' }], spec, { ...rt, notePath: null });
		expect(note?.content).not.toContain('quelle');
	});

	it('erweitert {{today}} im Ordner mit dem Zeitpunkt der Laufzeit', () => {
		const [note] = created([{ title: 'A', body: 'x' }], { ...spec, folder: 'Journal/{{today}}' });
		expect(note?.path).toBe('Journal/2026-11-14/A.md');
	});

	it('trimmt den Titel und lässt einen leeren Text zu', () => {
		const [note] = created([{ title: '  Angebot schicken \n', body: '' }]);
		expect(note?.path).toBe('10_Aufgaben/Angebot schicken.md');
		expect(note?.content.endsWith('---\n')).toBe(true);
	});

	it.each(['🙂 Idee', 'Q3', 'Überfällig', '2026'])('nimmt den Titel %j an', (title) => {
		expect(run([{ title, body: 'x' }]).ok).toBe(true);
	});

	it.each(['Kunde/Meyer', 'a\\b', '', '   ', '🙂', '...', '--', 'a\nb', 'x'.repeat(121), `${'🙂'.repeat(120)}`])('lehnt den Titel %j ab', (title) => {
		const r = run([{ title, body: 'x' }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/items\[0\]\.title/);
	});

	it('zählt die 120 Zeichen des Titels als Codepunkte, nicht als UTF-16-Einheiten', () => {
		expect(run([{ title: `a${'🙂'.repeat(119)}`, body: 'x' }]).ok).toBe(true);
		expect(run([{ title: `a${'🙂'.repeat(120)}`, body: 'x' }]).ok).toBe(false);
		expect(run([{ title: 'x'.repeat(120), body: 'x' }]).ok).toBe(true);
	});

	it('lehnt einen Text ab, der kein Text ist', () => {
		expect(run([{ title: 'A' }]).ok).toBe(false);
		expect(run([{ title: 'A', body: 3 }]).ok).toBe(false);
		expect(run(['A']).ok).toBe(false);
	});

	it('lehnt mehr als max_items ab, nimmt genau max_items an', () => {
		const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `t${i}`, body: 'x' }));
		const over = run(items(6));
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.errors.join('\n')).toMatch(/max_items/);
		expect(run(items(5)).ok).toBe(true);
	});

	it('lehnt eine Antwort ohne items-Liste ab, eine leere Liste ist keine Notiz', () => {
		expect(makeNotesCreate(spec, rt).validate({}, sources, noSlugs, null).ok).toBe(false);
		const r = run([]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.actions).toEqual([]);
	});

	it('nennt Vertrag und Beispiel', () => {
		const schema = makeNotesCreate(spec, rt);
		expect(schema.outputFormat).toBe('json');
		expect(schema.promptContract).toContain('5');
		expect(schema.outputExample).toBe('{"items": [{"title": "Angebot an Meyer schicken", "body": "Bis Freitag, Vorlage vom letzten Mal."}]}');
	});

	it('buildSchema reicht die Laufzeit durch; ohne sie ist die Familie nicht baubar', () => {
		const out: OutputSpec = spec;
		expect(buildSchema(out, rt).id).toBe('notes.create');
		expect(() => buildSchema(out)).toThrow(/SchemaRuntime/);
		expect(buildSchema({ family: 'text.append', maxChars: 10, heading: null }).id).toBe('text.append');
	});
});
