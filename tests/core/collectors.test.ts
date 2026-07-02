import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fnv1a, runCollector } from '../../src/core/collectors';
import { buildDenylist } from '../../src/core/paths';
import type { CollectorTaskDef } from '../../src/core/types';
import { FixtureMetadataPort, InMemoryVaultPort } from '../helpers/in-memory-vault';

const FIXTURE_DIR = join(__dirname, '../fixtures/pallas-tasknotes');
const DENYLIST = buildDenylist('.obsidian');

let vault: InMemoryVaultPort;
let meta: FixtureMetadataPort;
let deps: { vault: InMemoryVaultPort; meta: FixtureMetadataPort; denylist: string[] };

beforeEach(async () => {
	vault = new InMemoryVaultPort();
	meta = new FixtureMetadataPort(vault);
	deps = { vault, meta, denylist: DENYLIST };
	for (const f of readdirSync(FIXTURE_DIR)) {
		await vault.create(`10_Aufgaben/${f}`, readFileSync(join(FIXTURE_DIR, f), 'utf8'));
	}
	await vault.create('_crews/teams/x.md', '---\ncrew-kind: team\n---\n');
});

function def(collector: CollectorTaskDef['collector'], params: Record<string, unknown>): CollectorTaskDef {
	return { id: 'collect', kind: 'collector', collector, params };
}

describe('fnv1a', () => {
	it('ist deterministisch und unterscheidet Inhalte', () => {
		expect(fnv1a('abc')).toBe(fnv1a('abc'));
		expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
		expect(fnv1a('')).toMatch(/^[0-9a-f]+$/);
	});
});

describe('vault.list', () => {
	it('listet Ordner-Dateien mit Hash, respektiert limit und Denylist', async () => {
		const a = await runCollector(def('vault.list', { folder: '10_Aufgaben', limit: 3 }), deps);
		expect(a.files.length).toBe(3);
		expect(a.files[0]?.contentHash).toMatch(/^[0-9a-f]+$/);
		expect(a.files.every((f) => f.content === null)).toBe(true);
		const all = await runCollector(def('vault.list', { folder: '_crews' }), deps);
		expect(all.files.length).toBe(0);
	});
});

describe('vault.read', () => {
	it('liest explizite Pfade mit Inhalt, blockt Denylist-Pfade', async () => {
		const a = await runCollector(def('vault.read', { paths: ['10_Aufgaben/steuer.md', '_crews/teams/x.md'] }), deps);
		expect(a.files.length).toBe(1);
		expect(a.files[0]?.content).toContain('Unterlagen liegen im Ordner.');
	});

	it('kappt übergroße Dateien mit Marker', async () => {
		await vault.create('10_Aufgaben/gross.md', `---\ntitle: x\n---\n${'y'.repeat(40_000)}`);
		const a = await runCollector(def('vault.read', { paths: ['10_Aufgaben/gross.md'] }), deps);
		expect((a.files[0]?.content ?? '').length).toBeLessThan(40_000);
		expect(a.files[0]?.content).toContain('[gekürzt]');
	});
});

describe('tasknotes.query', () => {
	it('filtert per where auf Slug-Werten und normalisiert Frontmatter', async () => {
		const a = await runCollector(def('tasknotes.query', {
			folder: '10_Aufgaben',
			where: { status: ['backlog'] },
			fields: ['title', 'status', 'priority', 'kontext'],
		}), deps);
		expect(a.files.map((f) => f.path).sort()).toEqual(['10_Aufgaben/steuer.md', '10_Aufgaben/zahnarzt.md']);
		const steuer = a.files.find((f) => f.path.endsWith('steuer.md'));
		expect(steuer?.frontmatter?.status).toBe('backlog');       // slug-normalisiert
		expect(steuer?.frontmatter?.priority).toBe('mittel');
		expect(steuer?.frontmatter?.kontext).toEqual([]);          // [null] → []
		expect(steuer?.frontmatter).not.toHaveProperty('projekt'); // fields-Projektion
		expect(a.slugTables.status?.fromSlug.backlog).toBe('1_backlog_📥');
	});

	it('where_missing findet Dateien ohne/mit leerem Key', async () => {
		const a = await runCollector(def('tasknotes.query', {
			folder: '10_Aufgaben',
			where_missing: ['priority'],
		}), deps);
		expect(a.files.map((f) => f.path)).toEqual(['10_Aufgaben/zahnarzt.md']);
	});

	it('sortiert deterministisch und limitiert', async () => {
		const a = await runCollector(def('tasknotes.query', { folder: '10_Aufgaben', sort: 'title', limit: 2 }), deps);
		expect(a.files.map((f) => f.path)).toEqual(['10_Aufgaben/garten.md', '10_Aufgaben/plugin.md']);
	});

	it('setzt taskId und json.files am Artifact', async () => {
		const a = await runCollector(def('tasknotes.query', { folder: '10_Aufgaben' }), deps);
		expect(a.taskId).toBe('collect');
		expect((a.json as { files: unknown[] }).files.length).toBe(4);
	});
});
