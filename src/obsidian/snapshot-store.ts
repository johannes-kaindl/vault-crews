/** SnapshotStore über app.vault.adapter (Design-Spec §3/§4): der Store liegt versteckt
 *  unter <configDir>/plugins/vault-crews/undo/ und ist NICHT im TFile-Index — daher
 *  Adapter-I/O (nicht vault.read/modify). Manifest wird write-ahead pro capture
 *  neu geschrieben (crash-sicher). Keine Shell-/Node-Dateisystem-Zugriffe — reine Obsidian-API. */
import type { App } from 'obsidian';
import { fnv1a } from '../core/collectors';
import { DEFAULT_GFS_POLICY, selectGfsRetention, type GfsEntry } from '../vendor/kit/rotation';
import type { SnapshotManifest, SnapshotStore } from '../core/ports';

export class AdapterSnapshotStore implements SnapshotStore {
	constructor(private readonly app: App) {}

	private get adapter(): App['vault']['adapter'] { return this.app.vault.adapter; }
	private root(): string { return `${this.app.vault.configDir}/plugins/vault-crews/undo`; }
	private runDir(runId: string): string { return `${this.root()}/${runId}`; }
	private manifestPath(runId: string): string { return `${this.runDir(runId)}/manifest.json`; }
	private blobPath(runId: string, blob: string): string { return `${this.runDir(runId)}/blobs/${blob}`; }

	async capture(runId: string, teamId: string, createdAt: number, path: string, existedBefore: boolean, preContent: string | null): Promise<void> {
		const manifest = (await this.load(runId)) ?? { runId, teamId, createdAt, entries: [] };
		if (manifest.entries.some((e) => e.path === path)) return; // first-write-wins

		let blob: string | null = null;
		let preHash: string | null = null;
		if (existedBefore && preContent !== null) {
			blob = `${manifest.entries.length}.snapshot`;
			preHash = fnv1a(preContent);
			await this.ensureDir(`${this.runDir(runId)}/blobs`);
			await this.adapter.write(this.blobPath(runId, blob), preContent);
		}
		manifest.entries.push({ path, existedBefore, preHash, postHash: null, blob });
		await this.ensureDir(this.runDir(runId));
		await this.adapter.write(this.manifestPath(runId), JSON.stringify(manifest, null, 2));
	}

	async finalize(runId: string, postHashes: Record<string, string>, keepLast: number, now: number): Promise<void> {
		const manifest = await this.load(runId);
		if (manifest !== null) {
			for (const e of manifest.entries) {
				const h = postHashes[e.path];
				if (h !== undefined) e.postHash = h;
			}
			await this.adapter.write(this.manifestPath(runId), JSON.stringify(manifest, null, 2));
		}
		await this.prune(keepLast, now);
	}

	async load(runId: string): Promise<SnapshotManifest | null> {
		try {
			if (!(await this.adapter.exists(this.manifestPath(runId)))) return null;
			return JSON.parse(await this.adapter.read(this.manifestPath(runId))) as SnapshotManifest;
		} catch {
			return null;
		}
	}

	async readBlob(runId: string, blob: string): Promise<string> {
		return this.adapter.read(this.blobPath(runId, blob));
	}

	async discard(runId: string): Promise<void> {
		try {
			if (await this.adapter.exists(this.runDir(runId))) await this.adapter.rmdir(this.runDir(runId), true);
		} catch { /* best effort */ }
	}

	async list(): Promise<string[]> {
		try {
			if (!(await this.adapter.exists(this.root()))) return [];
			const listed = await this.adapter.list(this.root());
			return listed.folders.map((f) => f.split('/').pop() ?? f);
		} catch {
			return [];
		}
	}

	/** Aufbewahrung nach Kit-GFS: `keepLast` gilt für den laufenden Tag, ältere Stände laufen je Tag/Woche/Monat
	 *  aus. Die Zeit ist `manifest.createdAt` (runId trägt Lokalzeit ohne Sekunden, nicht den Kit-Zeitstempel);
	 *  ohne lesbare Zeit bleibt der Stand erhalten. */
	private async prune(keepLast: number, now: number): Promise<void> {
		const entries: GfsEntry[] = [];
		for (const name of await this.list()) {
			const time = (await this.load(name))?.createdAt;
			if (typeof time === 'number' && Number.isFinite(time)) entries.push({ name, time });
		}
		const { drop } = selectGfsRetention(entries, now, { policy: { ...DEFAULT_GFS_POLICY, today: keepLast }, keepNewest: true });
		for (const id of drop) await this.discard(id);
	}

	/** Rekursiv: erzeugt fehlende Parent-Ordner mit (Obsidians adapter.mkdir ist nicht
	 *  rekursiv, und der undo-Root selbst wird sonst nie angelegt → list()/exists() leer). */
	private async ensureDir(dir: string): Promise<void> {
		if (await this.adapter.exists(dir)) return;
		const parent = dir.slice(0, dir.lastIndexOf('/'));
		if (parent !== '' && parent !== dir && !(await this.adapter.exists(parent))) await this.ensureDir(parent);
		await this.adapter.mkdir(dir);
	}
}
