import { describe, expect, it } from 'vitest';
import { FixtureMetadataPort, InMemoryVaultPort } from './in-memory-vault';
import { FakeClock } from './fake-clock';
import { ScriptLlmClient } from './script-llm';

const NOTE = `---
title: Steuererklärung
status: 1_backlog_📥
kontext:
  -
tags: [aufgabe, "amt"]
---
Body bleibt **byte-gleich**.
`;

describe('InMemoryVaultPort', () => {
	it('create wirft bei existierender Datei, modify ersetzt, append hängt an', async () => {
		const v = new InMemoryVaultPort();
		await v.create('a.md', 'x');
		await expect(v.create('a.md', 'y')).rejects.toThrow();
		await v.modify('a.md', 'y');
		await v.append('a.md', 'z');
		expect(await v.read('a.md')).toBe('yz');
		expect(await v.exists('b.md')).toBe(false);
	});

	it('patchFrontmatter setzt/entfernt Keys und lässt Body + fremde Keys byte-gleich', async () => {
		const v = new InMemoryVaultPort();
		await v.create('t.md', NOTE);
		await v.patchFrontmatter('t.md', { status: '2_aktiv_🔥', priority: 2 }, ['kontext']);
		const out = await v.read('t.md');
		expect(out).toContain('status: 2_aktiv_🔥');
		expect(out).toContain('priority: 2');
		expect(out).not.toContain('kontext');
		expect(out).toContain('title: Steuererklärung');       // unberührter Key byte-gleich
		expect(out).toContain('tags: [aufgabe, "amt"]');
		expect(out.endsWith('Body bleibt **byte-gleich**.\n')).toBe(true);
	});
});

describe('FixtureMetadataPort', () => {
	it('listet Ordner-Dateien, parst flaches Frontmatter, liefert Body', async () => {
		const v = new InMemoryVaultPort();
		await v.create('10_A/t.md', NOTE);
		await v.create('20_B/x.md', 'kein frontmatter');
		const m = new FixtureMetadataPort(v);
		expect(await m.listMarkdownFiles('10_A')).toEqual(['10_A/t.md']);
		const fm = await m.getFrontmatter('10_A/t.md');
		expect(fm?.status).toBe('1_backlog_📥');
		expect(fm?.kontext).toEqual([null]);
		expect(fm?.tags).toEqual(['aufgabe', 'amt']);
		expect(await m.getFrontmatter('20_B/x.md')).toBeNull();
		expect(await m.getBody('10_A/t.md')).toBe('Body bleibt **byte-gleich**.\n');
	});

	it('erlaubt Frontmatter-Overrides für verschachtelte Team-Definitionen', async () => {
		const v = new InMemoryVaultPort();
		await v.create('_crews/teams/t.md', '---\nplatzhalter: 1\n---\ndoku');
		const m = new FixtureMetadataPort(v);
		m.setFrontmatter('_crews/teams/t.md', { 'crew-kind': 'team', tasks: [{ id: 'c', kind: 'collector' }] });
		const fm = await m.getFrontmatter('_crews/teams/t.md');
		expect((fm?.tasks as unknown[]).length).toBe(1);
	});
});

describe('FakeClock', () => {
	it('führt Timer erst bei tick über die Schwelle aus', () => {
		const c = new FakeClock(1000);
		let fired = 0;
		c.setTimeout(() => { fired += 1; }, 500);
		const id = c.setTimeout(() => { fired += 10; }, 800);
		c.tick(499);
		expect(fired).toBe(0);
		c.clearTimeout(id);
		c.tick(2);
		expect(fired).toBe(1);
		expect(c.now()).toBe(1501);
	});
});

describe('ScriptLlmClient', () => {
	it('liefert gescriptete Antworten der Reihe nach und injiziert Fehler', async () => {
		const llm = new ScriptLlmClient([
			{ content: 'antwort-1' },
			{ error: 'overflow' },
		]);
		const tokens: string[] = [];
		const r = await llm.stream([{ role: 'user', content: 'q' }], { model: 'm', temperature: 0, maxTokens: 10, thinking: 'off' }, (t) => tokens.push(t), new AbortController().signal);
		expect(r.content).toBe('antwort-1');
		expect(tokens.join('')).toBe('antwort-1');
		await expect(llm.stream([{ role: 'user', content: 'q' }], { model: 'm', temperature: 0, maxTokens: 10, thinking: 'off' }, () => {}, new AbortController().signal))
			.rejects.toMatchObject({ kind: 'overflow' });
		expect(llm.calls.length).toBe(2);
	});
});
