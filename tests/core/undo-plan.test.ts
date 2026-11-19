import { describe, expect, it } from 'vitest';
import { buildUndoPlan } from '../../src/core/undo-plan';
import { fnv1a } from '../../src/core/collectors';
import type { SnapshotManifest } from '../../src/core/ports';

function manifest(entries: SnapshotManifest['entries']): SnapshotManifest {
	return { runId: '2026-07-06-1200-t', teamId: 't', createdAt: 0, entries };
}

describe('buildUndoPlan', () => {
	it('restauriert eine geänderte Existenz-Note aus ihrem Blob', () => {
		const pre = '# vorher\n';
		const m = manifest([{ path: 'a.md', existedBefore: true, preHash: fnv1a(pre), postHash: fnv1a('# nachher\n'), blob: '0.snapshot' }]);
		const plan = buildUndoPlan(m, { 'a.md': '# nachher\n' }, { '0.snapshot': pre });
		expect(plan.restores).toEqual([{ path: 'a.md', content: pre }]);
		expect(plan.deletes).toEqual([]);
		expect(plan.conflicts).toEqual([]);
	});

	it('löscht eine vom Lauf erzeugte Note (existedBefore=false, kein Blob)', () => {
		const m = manifest([{ path: 'neu.md', existedBefore: false, preHash: null, postHash: fnv1a('x'), blob: null }]);
		const plan = buildUndoPlan(m, { 'neu.md': 'x' }, {});
		expect(plan.deletes).toEqual(['neu.md']);
		expect(plan.restores).toEqual([]);
	});

	it('markiert einen Pfad als conflict, wenn der aktuelle Inhalt ≠ postHash ist', () => {
		const pre = 'alt\n';
		const m = manifest([{ path: 'a.md', existedBefore: true, preHash: fnv1a(pre), postHash: fnv1a('vom-lauf\n'), blob: '0.snapshot' }]);
		const plan = buildUndoPlan(m, { 'a.md': 'user-hat-editiert\n' }, { '0.snapshot': pre });
		expect(plan.conflicts).toEqual(['a.md']);
		// conflict blockiert nicht — restore bleibt im Plan:
		expect(plan.restores).toEqual([{ path: 'a.md', content: pre }]);
	});

	it('zählt einen Crash-Eintrag (postHash=null) NICHT als conflict', () => {
		const pre = 'alt\n';
		const m = manifest([{ path: 'a.md', existedBefore: true, preHash: fnv1a(pre), postHash: null, blob: '0.snapshot' }]);
		const plan = buildUndoPlan(m, { 'a.md': 'irgendwas\n' }, { '0.snapshot': pre });
		expect(plan.conflicts).toEqual([]);
		expect(plan.restores).toEqual([{ path: 'a.md', content: pre }]);
	});

	it('restauriert eine seit dem Lauf gelöschte Existenz-Note (current=null) via create', () => {
		const pre = 'alt\n';
		const m = manifest([{ path: 'a.md', existedBefore: true, preHash: fnv1a(pre), postHash: fnv1a('vom-lauf\n'), blob: '0.snapshot' }]);
		const plan = buildUndoPlan(m, { 'a.md': null }, { '0.snapshot': pre });
		// current=null && postHash gesetzt → seit dem Lauf entfernt → conflict-Warnung, restore trotzdem:
		expect(plan.conflicts).toEqual(['a.md']);
		expect(plan.restores).toEqual([{ path: 'a.md', content: pre }]);
	});

	describe('verschobene Notizen (movedFrom)', () => {
		it('schiebt eine nur verschobene Notiz zurück und schreibt keinen Inhalt', () => {
			const m = manifest([{ path: 'Ziel/a.md', movedFrom: 'Inbox/a.md', existedBefore: true, preHash: null, postHash: fnv1a('X'), blob: null }]);
			const p = buildUndoPlan(m, { 'Ziel/a.md': 'X', 'Inbox/a.md': null }, {});
			expect(p).toMatchObject({ moves: [{ from: 'Ziel/a.md', to: 'Inbox/a.md' }], restores: [], deletes: [], conflicts: [], skipped: [] });
		});

		it('schiebt zurück und stellt den Vorab-Inhalt am alten Pfad her', () => {
			const m = manifest([{ path: 'Ziel/a.md', movedFrom: 'Inbox/a.md', existedBefore: true, preHash: fnv1a('ALT'), postHash: fnv1a('NEU'), blob: 'b1' }]);
			const p = buildUndoPlan(m, { 'Ziel/a.md': 'NEU', 'Inbox/a.md': null }, { b1: 'ALT' });
			expect(p.moves).toEqual([{ from: 'Ziel/a.md', to: 'Inbox/a.md' }]);
			expect(p.restores).toEqual([{ path: 'Inbox/a.md', content: 'ALT' }]);
			expect(p.deletes).toEqual([]);
		});

		it.each([
			['die Notiz liegt nicht mehr am neuen Pfad', { 'Ziel/a.md': null, 'Inbox/a.md': null }],
			['der alte Pfad ist wieder belegt', { 'Ziel/a.md': 'X', 'Inbox/a.md': 'fremd' }],
		])('bewegt nichts, wenn %s', (_name, current) => {
			const m = manifest([{ path: 'Ziel/a.md', movedFrom: 'Inbox/a.md', existedBefore: true, preHash: null, postHash: fnv1a('X'), blob: null }]);
			const p = buildUndoPlan(m, current, {});
			expect(p.moves).toEqual([]);
			expect(p.restores).toEqual([]);
			expect(p.deletes).toEqual([]);
			expect(p.skipped).toEqual(['Ziel/a.md']);
			expect(p.conflicts).toContain('Ziel/a.md');
		});

		it('überspringt auch einen Eintrag mit Vorab-Inhalt, wenn der alte Pfad belegt ist (kein Überschreiben)', () => {
			const m = manifest([{ path: 'Ziel/a.md', movedFrom: 'Inbox/a.md', existedBefore: true, preHash: fnv1a('ALT'), postHash: fnv1a('NEU'), blob: 'b1' }]);
			const p = buildUndoPlan(m, { 'Ziel/a.md': 'NEU', 'Inbox/a.md': 'fremd' }, { b1: 'ALT' });
			expect(p.restores).toEqual([]);
			expect(p.moves).toEqual([]);
			expect(p.skipped).toEqual(['Ziel/a.md']);
		});

		it('rename scheiterte nach captureMove: Notiz noch am alten Pfad, Eintrag ohne postHash, nichts wird bewegt', () => {
			const m = manifest([{ path: 'Ziel/a.md', movedFrom: 'Inbox/a.md', existedBefore: true, preHash: null, postHash: null, blob: null }]);
			const p = buildUndoPlan(m, { 'Ziel/a.md': null, 'Inbox/a.md': 'X' }, {});
			expect(p).toMatchObject({ moves: [], restores: [], deletes: [], skipped: ['Ziel/a.md'], conflicts: ['Ziel/a.md'] });
		});

		describe('Vorab-Abbild bleibt erreichbar, wenn die Notiz nicht am neuen Pfad liegt', () => {
			const entry = (postHash: string | null) => manifest([{ path: 'Ziel/a.md', movedFrom: 'Inbox/a.md', existedBefore: true, preHash: fnv1a('ALT'), postHash, blob: 'b1' }]);

			it('rename scheiterte nach captureMove: der Blob geht ohne Zug an den alten Pfad (postHash null)', () => {
				const p = buildUndoPlan(entry(null), { 'Ziel/a.md': null, 'Inbox/a.md': 'ALT+Crew' }, { b1: 'ALT' });
				expect(p.moves).toEqual([]);
				expect(p.restores).toEqual([{ path: 'Inbox/a.md', content: 'ALT' }]);
				expect(p.skipped).toEqual([]);
				expect(p.unrestored).toEqual([]);
			});

			it('erster Rücknahmeversuch zog die Notiz zurück, der Restore fehlte: zweiter Versuch schreibt den Blob (postHash passt)', () => {
				const p = buildUndoPlan(entry(fnv1a('NEU')), { 'Ziel/a.md': null, 'Inbox/a.md': 'NEU' }, { b1: 'ALT' });
				expect(p.moves).toEqual([]);
				expect(p.restores).toEqual([{ path: 'Inbox/a.md', content: 'ALT' }]);
				expect(p.skipped).toEqual([]);
				expect(p.conflicts).toEqual([]);
			});

			it('fremd belegter alter Pfad (anderer Hash) bleibt unberührt, der Eintrag trägt den Blob weiter', () => {
				const p = buildUndoPlan(entry(fnv1a('NEU')), { 'Ziel/a.md': null, 'Inbox/a.md': 'fremd' }, { b1: 'ALT' });
				expect(p.moves).toEqual([]);
				expect(p.restores).toEqual([]);
				expect(p.skipped).toEqual(['Ziel/a.md']);
				expect(p.conflicts).toEqual(['Ziel/a.md']);
				expect(p.unrestored).toEqual(['Ziel/a.md']);
			});

			it('beide Pfade leer: nichts zu schreiben, der Blob bleibt unwiederhergestellt', () => {
				const p = buildUndoPlan(entry(null), { 'Ziel/a.md': null, 'Inbox/a.md': null }, { b1: 'ALT' });
				expect(p.restores).toEqual([]);
				expect(p.skipped).toEqual(['Ziel/a.md']);
				expect(p.unrestored).toEqual(['Ziel/a.md']);
			});

			it('zurückgeschobene Notiz mit dem Vorab-Inhalt am alten Pfad ist erledigt: kein Zug, kein Restore, nicht übersprungen', () => {
				const p = buildUndoPlan(entry(fnv1a('NEU')), { 'Ziel/a.md': null, 'Inbox/a.md': 'ALT' }, { b1: 'ALT' });
				expect(p).toMatchObject({ moves: [], restores: [], deletes: [], skipped: [], conflicts: [], unrestored: [] });
				expect(p.unrestoredWhy).toEqual({});
			});

			it('Grund je nicht wiederherstellbarem Pfad: weg (Notiz nicht am neuen Pfad) oder alter Pfad belegt (Notiz noch am neuen)', () => {
				const gone = buildUndoPlan(entry(null), { 'Ziel/a.md': null, 'Inbox/a.md': null }, { b1: 'ALT' });
				expect(gone.unrestoredWhy).toEqual({ 'Ziel/a.md': 'gone' });
				const taken = buildUndoPlan(entry(null), { 'Ziel/a.md': 'NEU', 'Inbox/a.md': 'fremd' }, { b1: 'ALT' });
				expect(taken.unrestored).toEqual(['Ziel/a.md']);
				expect(taken.unrestoredWhy).toEqual({ 'Ziel/a.md': 'taken' });
			});

			it('Notiz von Hand zurückgeschoben und bearbeitet: Grund „changed“, nicht „gone“ (am alten Pfad liegt eine Datei)', () => {
				const p = buildUndoPlan(entry(fnv1a('NEU')), { 'Ziel/a.md': null, 'Inbox/a.md': 'NEU, von Hand bearbeitet' }, { b1: 'ALT' });
				expect(p.unrestored).toEqual(['Ziel/a.md']);
				expect(p.unrestoredWhy).toEqual({ 'Ziel/a.md': 'changed' });
			});

			it('Eintrag ohne Blob gilt nie als unwiederhergestellt', () => {
				const m = manifest([{ path: 'Ziel/a.md', movedFrom: 'Inbox/a.md', existedBefore: true, preHash: null, postHash: null, blob: null }]);
				expect(buildUndoPlan(m, { 'Ziel/a.md': null, 'Inbox/a.md': 'X' }, {}).unrestored).toEqual([]);
			});
		});

		it('ein Eintrag ohne movedFrom hat nie einen Zug und ist nie übersprungen', () => {
			const m = manifest([{ path: 'a.md', existedBefore: true, preHash: fnv1a('alt'), postHash: fnv1a('neu'), blob: 'b' }]);
			const p = buildUndoPlan(m, { 'a.md': 'neu' }, { b: 'alt' });
			expect(p.moves).toEqual([]);
			expect(p.skipped).toEqual([]);
		});
	});
});
