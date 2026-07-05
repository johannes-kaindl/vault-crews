import { describe, expect, it } from 'vitest';
import { buildDenylist, expandTarget, globMatch, isDenied, normalizeVaultPath } from '../../src/core/paths';

const DENYLIST = buildDenylist('.obsidian', '_crews');

describe('normalizeVaultPath', () => {
	it('trimmt, vereinheitlicht Slashes und entfernt führende /', () => {
		expect(normalizeVaultPath(' 10_A\\sub\\x.md ')).toBe('10_A/sub/x.md');
		expect(normalizeVaultPath('/10_A/x.md')).toBe('10_A/x.md');
		expect(normalizeVaultPath('a//b.md')).toBe('a/b.md');
	});

	it('wirft bei ..-Segmenten (Escape-Versuch)', () => {
		expect(() => normalizeVaultPath('../x.md')).toThrow();
		expect(() => normalizeVaultPath('10_A/../.git/config')).toThrow();
	});
});

describe('globMatch', () => {
	it('matcht ** über Ordnergrenzen und * innerhalb eines Segments', () => {
		expect(globMatch('10_Aufgaben/**/*.md', '10_Aufgaben/sub/t.md')).toBe(true);
		expect(globMatch('10_Aufgaben/**/*.md', '10_Aufgaben/t.md')).toBe(true);
		expect(globMatch('10_Aufgaben/**/*.md', '20_X/t.md')).toBe(false);
		expect(globMatch('*.md', 'a/b.md')).toBe(false);
		expect(globMatch('a/*.md', 'a/b.md')).toBe(true);
	});

	it('behandelt Muster ohne Glob als exakten Pfad', () => {
		expect(globMatch('70_Journal/2026-07-02.md', '70_Journal/2026-07-02.md')).toBe(true);
		expect(globMatch('70_Journal/2026-07-02.md', '70_Journal/2026-07-03.md')).toBe(false);
	});
});

describe('isDenied', () => {
	it('blockt Systempfade und Dotfiles unabhängig von write_scope', () => {
		for (const p of ['.obsidian/app.json', '.git/config', '_crews/teams/x.md', '_vaultrag/notes.i8', '.env', 'a/.hidden.md']) {
			expect(isDenied(p, DENYLIST), p).toBe(true);
		}
		expect(isDenied('10_Aufgaben/t.md', DENYLIST)).toBe(false);
	});

	it('buildDenylist nutzt das injizierte configDir', () => {
		expect(buildDenylist('.config-custom', '_crews')).toEqual(expect.arrayContaining(['.config-custom/**', '.git/**', '_crews/**', '_vaultrag/**']));
	});

	// Regression (safety review C2): buildDenylist hardcodete früher das Literal
	// '_crews/**' statt den user-konfigurierbaren crewRoot zu verwenden. Ein
	// umbenannter crewRoot (PluginSettings.crewRoot, Freitext) blieb dadurch
	// ungeschützt — ein write_scope konnte legal die echte Crew-Config/Run-Logs/
	// Lock treffen (Selbst-Eskalation, Audit-Manipulation).
	it('schützt einen umbenannten crewRoot (Regression: Denylist folgte crewRoot-Setting nicht)', () => {
		const denylist = buildDenylist('.obsidian', 'Crew-Ops');
		expect(denylist).toEqual(expect.arrayContaining(['Crew-Ops/**']));
		expect(isDenied('Crew-Ops/teams/task-triage.md', denylist)).toBe(true);
		// Default-Root bleibt unter einem '_crews'-crewRoot weiterhin geschützt.
		expect(isDenied('_crews/teams/task-triage.md', DENYLIST)).toBe(true);
	});

	it('normalisiert crewRoot (trailing slash entfernt, leer/whitespace fällt auf _crews zurück)', () => {
		expect(buildDenylist('.obsidian', 'Crew-Ops/')).toEqual(expect.arrayContaining(['Crew-Ops/**']));
		expect(buildDenylist('.obsidian', '')).toEqual(expect.arrayContaining(['_crews/**']));
		expect(buildDenylist('.obsidian', '   ')).toEqual(expect.arrayContaining(['_crews/**']));
	});
});

describe('expandTarget', () => {
	it('ersetzt {{today}} durch lokales YYYY-MM-DD', () => {
		// 2026-07-02 12:00 lokal
		const now = new Date(2026, 6, 2, 12, 0, 0).getTime();
		expect(expandTarget('70_Journal/{{today}}.md', now)).toBe('70_Journal/2026-07-02.md');
		expect(expandTarget('a/b.md', now)).toBe('a/b.md');
	});
});
