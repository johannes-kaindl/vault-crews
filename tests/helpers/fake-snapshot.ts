/** Test-Double des SnapshotStore auf In-Memory-Maps — spiegelt AdapterSnapshotStore
 *  (first-write-wins, finalize trägt postHashes nach), ohne Adapter-I/O. `log`/`finalized`
 *  erlauben Assertions über die Snapshot-Aktivität eines Laufs. */
import { fnv1a } from '../../src/core/collectors';
import type { SnapshotManifest, SnapshotStore } from '../../src/core/ports';

export class FakeSnapshotStore implements SnapshotStore {
	readonly manifests = new Map<string, SnapshotManifest>();
	readonly blobs = new Map<string, string>();
	readonly finalized: string[] = [];
	readonly log: string[] = [];

	async capture(runId: string, teamId: string, createdAt: number, path: string, existedBefore: boolean, preContent: string | null): Promise<void> {
		this.log.push(`capture:${path}`);
		const m = this.manifests.get(runId) ?? { runId, teamId, createdAt, entries: [] };
		if (m.entries.some((e) => e.path === path)) return; // first-write-wins
		let blob: string | null = null;
		let preHash: string | null = null;
		if (existedBefore && preContent !== null) {
			blob = `${m.entries.length}.snapshot`;
			preHash = fnv1a(preContent);
			this.blobs.set(`${runId}/${blob}`, preContent);
		}
		m.entries.push({ path, existedBefore, preHash, postHash: null, blob });
		this.manifests.set(runId, m);
	}

	async finalize(runId: string, postHashes: Record<string, string>, _keepLast: number): Promise<void> {
		this.log.push(`finalize:${runId}`);
		this.finalized.push(runId);
		const m = this.manifests.get(runId);
		if (m) for (const e of m.entries) { const h = postHashes[e.path]; if (h !== undefined) e.postHash = h; }
	}

	async load(runId: string): Promise<SnapshotManifest | null> { return this.manifests.get(runId) ?? null; }
	async readBlob(runId: string, blob: string): Promise<string> { return this.blobs.get(`${runId}/${blob}`) ?? ''; }
	async discard(runId: string): Promise<void> { this.manifests.delete(runId); }
	async list(): Promise<string[]> { return [...this.manifests.keys()]; }

	/** Die vom Lauf gesnapshotteten Pfade (Manifest-Reihenfolge). */
	paths(runId: string): string[] { return (this.manifests.get(runId)?.entries ?? []).map((e) => e.path); }
}

/** Snapshot-Store, dessen finalize() immer wirft — modelliert einen I/O-Fehler NACH
 *  den bereits angewandten Vault-Writes (Finalize-Resilienz, analog zum alten
 *  ApplyPlanFailsGitPort). */
export class FinalizeFailsSnapshotStore extends FakeSnapshotStore {
	override async finalize(runId: string, _postHashes: Record<string, string>, _keepLast: number): Promise<void> {
		this.log.push(`finalize:reject:${runId}`);
		throw new Error('snapshot finalize failed: adapter write rejected');
	}
}
