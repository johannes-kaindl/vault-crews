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
});
