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
	unrestored: string[];                           // Teilmenge von skipped: Eintrag trägt ein Vorab-Abbild (Blob), das nicht zurückgeschrieben wird
	unrestoredWhy: Record<string, UnrestoredReason>; // Pfad aus `unrestored` → Grund (für den Dialog „Lauf verwerfen“)
}

/** `gone`: an keinem der beiden Pfade liegt etwas. `changed`: die Notiz liegt nicht am neuen Pfad, der alte Pfad ist belegt
 *  (etwa von Hand zurückgeschoben und bearbeitet). `taken`: sie liegt noch am neuen Pfad, aber der alte Pfad ist belegt;
 *  nach dem Freiräumen des alten Pfads ist der Eintrag wiederherstellbar. */
export type UnrestoredReason = 'gone' | 'changed' | 'taken';

/**
 * @param currentContents Pfad → aktueller Inhalt (null = existiert nicht mehr).
 * @param blobs           Blob-Name → Pre-Image-Inhalt.
 * conflict gdw. postHash!=null && (current===null || fnv1a(current) !== postHash) —
 * die Note wurde seit dem Lauf editiert/entfernt. postHash===null (Crash) → nie conflict.
 *
 * Ein Eintrag mit `movedFrom` (path = neuer Pfad) erzeugt einen Zug zurück und, nur bei `blob !== null`, das Zurückschreiben
 * des Vorab-Inhalts am alten Pfad. Liegt die Notiz nicht am neuen Pfad (`current[path] === null`), gilt: Liegt sie schon am alten Pfad
 * (`rename` scheiterte nach `captureMove`, oder ein erster Rücknahmeversuch zog sie zurück und scheiterte am Restore), trägt der
 * Eintrag einen Blob und ist `postHash` null oder gleich dem Hash des Inhalts am alten Pfad, wird der Blob ohne Zug dort
 * zurückgeschrieben. Jeder andere Fall ohne Notiz am neuen Pfad oder mit belegtem alten Pfad kommt ohne Zug und ohne Zurückschreiben
 * in `skipped` und `conflicts`: nie eine fremde Datei überschreiben. Trägt ein solcher Eintrag einen Blob, steht er zusätzlich
 * in `unrestored`; der Aufrufer verwirft den Snapshot dann nicht.
 * Liegt am alten Pfad schon genau der Vorab-Inhalt (`old === blobs[e.blob]`, etwa nach einem teilweisen Rückgängig, das die Notiz
 * zurückschob), ist der Eintrag erledigt: kein Zug, kein Zurückschreiben, weder in `skipped` noch in `unrestored`.
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
	const unrestored: string[] = [];
	const unrestoredWhy: Record<string, UnrestoredReason> = {};
	const at = (path: string): string | null => (path in currentContents ? currentContents[path] ?? null : null);

	for (const e of manifest.entries) {
		const current = at(e.path);
		if (e.movedFrom !== undefined) {
			const old = at(e.movedFrom);
			if (current === null && old !== null && e.blob !== null && old === blobs[e.blob]) continue;
			if (current === null && old !== null && e.blob !== null && (e.postHash === null || fnv1a(old) === e.postHash)) {
				restores.push({ path: e.movedFrom, content: blobs[e.blob] ?? '' });
				continue;
			}
			if (current === null || old !== null) {
				skipped.push(e.path);
				conflicts.push(e.path);
				if (e.blob !== null) {
					unrestored.push(e.path);
					unrestoredWhy[e.path] = current !== null ? 'taken' : old === null ? 'gone' : 'changed';
				}
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
	return { moves, restores, deletes, conflicts, skipped, unrestored, unrestoredWhy };
}
