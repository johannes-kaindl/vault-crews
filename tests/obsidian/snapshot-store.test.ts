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
		await store.finalize('R1', { 'a.md': fnv1a('neu\n') }, 15, Date.now());
		const m = await store.load('R1');
		expect(m!.entries[0]!.postHash).toBe(fnv1a('neu\n'));
	});

	/** Lokalzeit wie formatRunId: YYYY-MM-DD-HHMM-<team>; createdAt = derselbe Zeitpunkt. */
	const runAt = (y: number, mo: number, d: number, h = 9, mi = 0): { id: string; at: number } => {
		const at = new Date(y, mo - 1, d, h, mi).getTime();
		const pad = (n: number): string => String(n).padStart(2, '0');
		return { id: `${y}-${pad(mo)}-${pad(d)}-${pad(h)}${pad(mi)}-t`, at };
	};
	const seed = async (runs: { id: string; at: number }[]): Promise<void> => {
		for (const r of runs) await store.capture(r.id, 't', r.at, 'a.md', true, 'x\n');
	};

	it('finalize: gestrige Stände fallen nach GFS (nicht nach Zahl)', async () => {
		// 30 Läufe heute, 5 Wochen alte Stände: Tiefe 2 gilt nur für den laufenden Tag.
		const now = new Date(2026, 9, 11, 12, 0).getTime();
		const old = [runAt(2026, 8, 3), runAt(2026, 8, 4), runAt(2026, 8, 5)]; // > 4 Wochen her → fällt (Monatsfenster behält den ältesten je Monat)
		const today = [runAt(2026, 10, 11, 8), runAt(2026, 10, 11, 9), runAt(2026, 10, 11, 10), runAt(2026, 10, 11, 11)];
		await seed([...old, ...today]);
		await store.finalize(today[3]!.id, {}, 2, now);
		const ids = (await store.list()).sort();
		// heute: die 2 neuesten plus der älteste des Tages (Tagesfenster); August: nur der älteste je Monat; der Rest fällt
		expect(ids).toEqual([old[0]!.id, today[0]!.id, today[2]!.id, today[3]!.id]);
	});

	it('finalize: keepNewest schützt den frischen Lauf auch bei Tiefe 0-artigem Fenster', async () => {
		const now = new Date(2026, 9, 11, 12, 0).getTime();
		const r = runAt(2026, 10, 11, 11);
		await seed([r]);
		await store.finalize(r.id, {}, 1, now);
		expect(await store.list()).toEqual([r.id]);
	});

	it('finalize: Altbestand 15 Stände über 15 Tage — Überlebende exakt (sieben Tage je Tag, davor je Woche/Monat)', async () => {
		const now = new Date(2026, 9, 15, 12, 0).getTime();
		const runs = Array.from({ length: 15 }, (_, i) => runAt(2026, 10, i + 1)); // 1.–15. Oktober
		await seed(runs);
		await store.finalize(runs[14]!.id, {}, 15, now);
		const ids = (await store.list()).sort();
		// 9.–15. (days=7) bleiben je Tag; davor je ISO-Woche der älteste (KW ab Mo 28.9.: der 1.; ab Mo 5.10.: der 5.); der Monat Oktober trägt den 1.
		const expected = [1, 5, 9, 10, 11, 12, 13, 14, 15].map((d) => runs[d - 1]!.id);
		expect(ids).toEqual(expected);
	});

	it('finalize: unbekannte Zeit bleibt erhalten', async () => {
		const now = new Date(2026, 9, 11, 12, 0).getTime();
		await store.capture('R1', 't', Number.NaN, 'a.md', true, 'x\n');
		const r = runAt(2026, 10, 11, 11);
		await seed([r]);
		await store.finalize(r.id, {}, 1, now);
		expect((await store.list()).sort()).toEqual([r.id, 'R1']);
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
