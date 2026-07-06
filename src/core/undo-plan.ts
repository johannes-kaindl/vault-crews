/** Purer Undo-Planer (Design-Spec §4): berechnet aus einem SnapshotManifest + den
 *  aktuellen Inhalten die Rollback-Operationen. Reiner pure/obsidian-Split —
 *  I/O macht der Aufrufer (main.ts über VaultPort + SnapshotStore), hier lebt nur Logik.
 *  Import von obsidian ist verboten (check:pure). */
import { fnv1a } from './collectors';
import type { SnapshotManifest } from './ports';

export interface UndoPlan {
	restores: { path: string; content: string }[]; // existedBefore=true → Pre-Image zurückschreiben
	deletes: string[];                              // existedBefore=false → in Papierkorb
	conflicts: string[];                            // Warn-Overlay (Teilmenge von restores/deletes)
}

/**
 * @param currentContents Pfad → aktueller Inhalt (null = existiert nicht mehr).
 * @param blobs           Blob-Name → Pre-Image-Inhalt.
 * conflict gdw. postHash!=null && (current===null || fnv1a(current) !== postHash) —
 * die Note wurde seit dem Lauf editiert/entfernt. postHash===null (Crash) → nie conflict.
 */
export function buildUndoPlan(
	manifest: SnapshotManifest,
	currentContents: Record<string, string | null>,
	blobs: Record<string, string>,
): UndoPlan {
	const restores: { path: string; content: string }[] = [];
	const deletes: string[] = [];
	const conflicts: string[] = [];

	for (const e of manifest.entries) {
		const current = e.path in currentContents ? currentContents[e.path] : null;
		if (e.postHash !== null) {
			const changed = current === null || fnv1a(current) !== e.postHash;
			if (changed) conflicts.push(e.path);
		}
		if (e.existedBefore) {
			const content = e.blob !== null ? (blobs[e.blob] ?? '') : '';
			restores.push({ path: e.path, content });
		} else {
			deletes.push(e.path);
		}
	}
	return { restores, deletes, conflicts };
}
