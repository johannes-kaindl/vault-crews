import { describe, expect, it } from 'vitest';
import { buildDenylist, expandTarget, globMatch, isDenied, normalizeVaultPath } from '../../src/core/paths';

const DENYLIST = buildDenylist('.obsidian', '_crews');

describe('normalizeVaultPath', () => {
	it('trimmt, vereinheitlicht Slashes und entfernt führende /', () => {
		expect(normalizeVaultPath(' 10_A\\sub\\x.md ')).toBe('10_A/sub/x.md');
		expect(normalizeVaultPath('/10_A/x.md')).toBe('10_A/x.md');
		expect(normalizeVaultPath('a//b.md')).toBe('a/b.md');
	});

	it('verliert das .-Segment (Kit rel-path): ./a und a/./b sind a und a/b, die Denylist sieht beide Schreibweisen gleich', () => {
		expect(normalizeVaultPath('./a.md')).toBe('a.md');
		expect(normalizeVaultPath('a/./b.md')).toBe('a/b.md');
		expect(isDenied(normalizeVaultPath('./.obsidian/x.json'), DENYLIST)).toBe(true);
	});

	it('wirft bei NUL und bei .. mit Leerraum drumherum (neu abgelehnt)', () => {
		expect(() => normalizeVaultPath('a\0b.md')).toThrow();
		expect(() => normalizeVaultPath('a/.. /b.md')).toThrow();
	});

	it('der Wurzelordner bleibt ein gültiges Ergebnis (leerer Ordner = ganzer Vault)', () => {
		expect(normalizeVaultPath('')).toBe('');
		expect(normalizeVaultPath('/')).toBe('');
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

// Welle 25 (Sicherheit): die Denylist liest einen Pfad wie das strengste Dateisystem (Kit folder-scope, `filesystemPath`). Vorher liefen
// `_crews /x.md`, `_crews./x.md`, `_crews:s/x.md` und `_CREWS/x.md` (APFS faltet die Schreibweise) an `_crews/**` vorbei.
describe('isDenied — Dateisystem-Lesart (Welle 25)', () => {
	it.each([
		'_crews /teams/x.md', '_crews./teams/x.md', '_crews:s/teams/x.md', '_CREWS/teams/x.md', '_Crews/teams/x.md',
		'_crews . /teams/x.md', '_crews\u00a0/teams/x.md', '_crews\u202f/teams/x.md', '_crews:/teams/x.md',
		'.obsidian /app.json', '.obsidian./app.json', '.OBSIDIAN/app.json', '.obsidian:x/app.json',
		'.git /config', '.git./config', '.GIT/config', '.git:$INDEX_ALLOCATION/config',
		'_vaultrag /notes.i8', '_vaultrag./notes.i8', '_VAULTRAG/notes.i8',
		'_crews/.../teams/x.md',
	])('verweigert %s', (p) => {
		expect(isDenied(p, DENYLIST), p).toBe(true);
	});

	it('faltet die Schreibweise wie das Dateisystem: langes s, Eszett und Kelvin-Zeichen', () => {
		const denylist = buildDenylist('.obsidian', 'Crew-Ops');
		expect(isDenied('Crew-Opſ/x.md', denylist)).toBe(true);
		expect(isDenied('CREW-OPS/x.md', denylist)).toBe(true);
		expect(isDenied('_vaultraG/x.md', DENYLIST)).toBe(true);
		expect(isDenied('.obsidiaN/x.md', DENYLIST)).toBe(true);
		const kelvin = buildDenylist('.config', 'Kommando');
		expect(isDenied('\u212Aommando/x.md', kelvin)).toBe(true);
	});

	it('liest auch ein Muster der Denylist nach denselben Regeln (configDir mit Großbuchstaben, crewRoot mit Leerraum am Ende)', () => {
		const denylist = buildDenylist('.Obsidian', 'Crew Ops ');
		expect(isDenied('.obsidian/app.json', denylist)).toBe(true);
		expect(isDenied('.Obsidian/app.json', denylist)).toBe(true);
		expect(isDenied('crew ops/x.md', denylist)).toBe(true);
	});

	it('Gegenprobe: ähnliche, erlaubte Pfade bleiben erlaubt', () => {
		for (const p of ['_crewsX/x.md', 'x_crews/x.md', 'a/_crews x/y.md', '_crew/x.md', '10_Aufgaben/t.md', '10_Aufgaben /t.md', 'Notizen/obsidian/x.md', 'obsidianer.md']) {
			expect(isDenied(p, DENYLIST), p).toBe(false);
		}
	});

	it('ein Pfad mit NUL hat keine Dateisystem-Lesart; der Rohpfad entscheidet weiter', () => {
		expect(isDenied('_crews/x\0.md', DENYLIST)).toBe(true);
		expect(isDenied('10_Aufgaben/x\0.md', DENYLIST)).toBe(false);
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
