import { describe, expect, it } from 'vitest';
import { buildSchema, makeFrontmatterSet, makeSectionWrite } from '../../src/core/schemas';
import type { CollectedFile, SlugTableData } from '../../src/core/types';

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
		const schema = makeSectionWrite(16000);
		const r = schema.validate('# Hallo', sources, noSlugs, '30_Chronos/heute.md');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.actions).toEqual([{ type: 'section.replace', path: '30_Chronos/heute.md', content: '# Hallo' }]);
	});

	it('rejects text over maxChars', () => {
		const schema = makeSectionWrite(5);
		const r = schema.validate('123456', sources, noSlugs, '30_Chronos/heute.md');
		expect(r.ok).toBe(false);
	});
});

describe('buildSchema', () => {
	it('dispatches frontmatter.set', () => {
		expect(buildSchema({ family: 'frontmatter.set', allowedKeys: ['tags'] }).outputFormat).toBe('json');
	});
	it('dispatches section.write', () => {
		expect(buildSchema({ family: 'section.write', maxChars: 16000 }).outputFormat).toBe('text');
	});
});
