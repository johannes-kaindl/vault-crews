/** Purer Undo-Planer (Design-Spec §4): berechnet aus einem SnapshotManifest + den
 *  aktuellen Inhalten die Rollback-Operationen. Reiner pure/obsidian-Split —
 *  I/O macht der Aufrufer (main.ts über VaultPort + SnapshotStore), hier lebt nur Logik.
 *  Import von obsidian ist verboten (check:pure). */
import { fnv1a } from './collectors';
import type { SnapshotManifest } from './ports';

export interface UndoPlan {
	moves: { from: string; to: string }[];          // movedFrom gesetzt → Notiz vom neuen zurück an den alten Pfad (läuft vor restores)
	skipped: string[];                              // Zug nicht ausführbar (Teilmenge von conflicts): Eintrag bleibt unberührt
	restores: { path: string; content: string }[]; // existedBefore=true → Pre-Image zurückschreiben
	deletes: string[];                              // existedBefore=false → in Papierkorb
	conflicts: string[];                            // Warn-Overlay (Teilmenge von restores/deletes)
}

/**
 * @param currentContents Pfad → aktueller Inhalt (null = existiert nicht mehr).
 * @param blobs           Blob-Name → Pre-Image-Inhalt.
 * conflict gdw. postHash!=null && (current===null || fnv1a(current) !== postHash) —
 * die Note wurde seit dem Lauf editiert/entfernt. postHash===null (Crash) → nie conflict.
 *
 * Ein Eintrag mit `movedFrom` (path = neuer Pfad) erzeugt einen Zug zurück und, nur bei `blob !== null`, das Zurückschreiben
 * des Vorab-Inhalts am alten Pfad. Ist `current[path] === null` (die Notiz liegt nicht am neuen Pfad; auch der Fall, dass `rename`
 * nach `captureMove` scheiterte) oder `current[movedFrom] !== null` (der alte Pfad ist wieder belegt), kommt der Eintrag ohne Zug und
 * ohne Zurückschreiben in `skipped` und `conflicts`, auch wenn `postHash` zu `current` passt: nie eine fremde Datei überschreiben.
 * Ein Eintrag mit `movedFrom` und `existedBefore: false` kann nicht entstehen (die Quelle eines `note.move` lag vor dem Lauf im
 * Sammelmaterial); er bekäme hier nur den Zug zurück und kein Löschen.
 */
export function buildUndoPlan(
	manifest: SnapshotManifest,
	currentContents: Record<string, string | null>,
	blobs: Record<string, string>,
): UndoPlan {
	const restores: { path: string; content: string }[] = [];
	const deletes: string[] = [];
	const conflicts: string[] = [];
	const moves: { from: string; to: string }[] = [];
	const skipped: string[] = [];
	const at = (path: string): string | null => (path in currentContents ? currentContents[path] ?? null : null);

	for (const e of manifest.entries) {
		const current = at(e.path);
		if (e.movedFrom !== undefined) {
			if (current === null || at(e.movedFrom) !== null) {
				skipped.push(e.path);
				conflicts.push(e.path);
				continue;
			}
			if (e.postHash !== null && fnv1a(current) !== e.postHash) conflicts.push(e.path);
			moves.push({ from: e.path, to: e.movedFrom });
			if (e.blob !== null) restores.push({ path: e.movedFrom, content: blobs[e.blob] ?? '' });
			continue;
		}
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
	return { moves, restores, deletes, conflicts, skipped };
}
