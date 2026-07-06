import { beforeEach, describe, expect, it } from 'vitest';
import { AdapterSnapshotStore } from '../../src/obsidian/snapshot-store';
import { fnv1a } from '../../src/core/collectors';

/** Minimaler In-Memory-DataAdapter (nur die vom Store genutzten Methoden). */
class FakeAdapter {
	files = new Map<string, string>();
	dirs = new Set<string>();
	async exists(p: string): Promise<boolean> { return this.files.has(p) || this.dirs.has(p); }
	async mkdir(p: string): Promise<void> { this.dirs.add(p); }
	async read(p: string): Promise<string> { const v = this.files.get(p); if (v === undefined) throw new Error('ENOENT ' + p); return v; }
	async write(p: string, d: string): Promise<void> { this.files.set(p, d); }
	async remove(p: string): Promise<void> { this.files.delete(p); }
	async rmdir(p: string, _r: boolean): Promise<void> {
		this.dirs.delete(p);
		for (const k of [...this.files.keys()]) if (k.startsWith(p + '/')) this.files.delete(k);
		for (const d of [...this.dirs]) if (d.startsWith(p + '/')) this.dirs.delete(d);
	}
	async list(p: string): Promise<{ files: string[]; folders: string[] }> {
		const folders = new Set<string>();
		const add = (key: string): void => {
			if (key.startsWith(p + '/')) { const seg = key.slice(p.length + 1).split('/')[0]; if (seg) folders.add(p + '/' + seg); }
		};
		for (const k of this.files.keys()) add(k);
		for (const d of this.dirs) add(d);
		return { files: [], folders: [...folders] };
	}
}

function fakeApp(): { app: any; adapter: FakeAdapter } {
	const adapter = new FakeAdapter();
	return { app: { vault: { adapter, configDir: '.obsidian' } }, adapter };
}

describe('AdapterSnapshotStore', () => {
	let store: AdapterSnapshotStore;

	beforeEach(() => { store = new AdapterSnapshotStore(fakeApp().app); });

	it('capture schreibt Blob + Manifest write-ahead; load liest es zurück', async () => {
		await store.capture('R1', 'team', 100, 'a.md', true, 'alt\n');
		const m = await store.load('R1');
		expect(m).not.toBeNull();
		expect(m!.entries).toHaveLength(1);
		expect(m!.entries[0]).toMatchObject({ path: 'a.md', existedBefore: true, preHash: fnv1a('alt\n'), postHash: null });
		expect(await store.readBlob('R1', m!.entries[0]!.blob!)).toBe('alt\n');
	});

	it('capture ist first-write-wins pro Pfad im selben Lauf', async () => {
		await store.capture('R1', 'team', 100, 'a.md', true, 'erste\n');
		await store.capture('R1', 'team', 100, 'a.md', true, 'zweite\n');
		const m = await store.load('R1');
		expect(m!.entries).toHaveLength(1);
		expect(await store.readBlob('R1', m!.entries[0]!.blob!)).toBe('erste\n');
	});

	it('capture einer erzeugten Note (existedBefore=false) legt keinen Blob an', async () => {
		await store.capture('R1', 'team', 100, 'neu.md', false, null);
		const m = await store.load('R1');
		expect(m!.entries[0]).toMatchObject({ existedBefore: false, blob: null, preHash: null });
	});

	it('finalize trägt postHashes nach', async () => {
		await store.capture('R1', 'team', 100, 'a.md', true, 'alt\n');
		await store.finalize('R1', { 'a.md': fnv1a('neu\n') }, 15);
		const m = await store.load('R1');
		expect(m!.entries[0]!.postHash).toBe(fnv1a('neu\n'));
	});

	it('finalize pruned auf keepLast Läufe (ältere runIds werden verworfen)', async () => {
		for (const id of ['2026-07-01-0900-t', '2026-07-02-0900-t', '2026-07-03-0900-t']) {
			await store.capture(id, 't', 0, 'a.md', true, 'x\n');
		}
		await store.finalize('2026-07-03-0900-t', {}, 2);
		const ids = (await store.list()).sort();
		expect(ids).toEqual(['2026-07-02-0900-t', '2026-07-03-0900-t']);
	});

	it('discard entfernt einen Snapshot; load liefert danach null', async () => {
		await store.capture('R1', 'team', 100, 'a.md', true, 'alt\n');
		await store.discard('R1');
		expect(await store.load('R1')).toBeNull();
	});

	it('load liefert null für unbekannten Lauf', async () => {
		expect(await store.load('unbekannt')).toBeNull();
	});
});
