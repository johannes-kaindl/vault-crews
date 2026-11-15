import { localDate } from '../vendor/kit/local-stamp';
import { filesystemPath } from '../vendor/kit/folder-scope';
import { normalizeRelPath } from '../vendor/kit/rel-path';
import type { TeamDef } from './types';

/** Pfad-Guards des pure-Layers. Jede Schreib-/Leseaktion der Agenten läuft hier durch —
 *  die Denylist überstimmt jede write_scope-Whitelist (Spec §4.4). */

/** Denylist mit injiziertem Obsidian-configDir (`Vault#configDir` — der Ordnername ist
 *  user-konfigurierbar, deshalb kein Literal im pure-Layer) UND dem konfigurierbaren
 *  crewRoot (`PluginSettings.crewRoot`, Default `_crews` — Freitext-Setting, deshalb
 *  ebenfalls kein Literal: sonst wäre ein umbenannter crewRoot ungeschützt und ein
 *  write_scope könnte legal die eigene Crew-Config/Run-Logs/Lock treffen). `_vaultrag/**`
 *  bleibt Literal — feste externe Konvention (vault-rag-Index), kein Plugin-Setting. */
export function buildDenylist(configDir: string, crewRoot: string): string[] {
	const root = crewRoot.trim().replace(/\/+$/, '') || '_crews';
	// '**/.*' deckt Dot-DATEIEN, '**/.*/**' Inhalte UNTER Dot-Ordnern (vom
	// Guard-Property-Test gefundenes Loch: 'sub/.trash/evil.md').
	return [`${configDir}/**`, '.git/**', `${root}/**`, '_vaultrag/**', '.*', '**/.*', '**/.*/**'];
}

/** Vault-relative Pfade vereinheitlichen (Kit `rel-path`, seit Welle 24): ein `..`-Segment (auch mit Leerraum drumherum) und ein
 *  NUL sind Fehler (Escape); `.`- und leere Segmente fallen weg (`./a` ist `a`, die Denylist sieht beide Schreibweisen gleich),
 *  `\` trennt wie `/`, ein führendes `/` heißt Vault-Wurzel. Der Wurzelordner (`""`) bleibt gültig. */
export function normalizeVaultPath(p: string): string {
	const r = normalizeRelPath(p.trim(), { absolute: 'strip', allowEmpty: true });
	if (!r.ok) throw new Error(`Pfad ungültig (${r.problem}): ${p}`);
	return r.path;
}

/** Minimaler Glob: `**` über Ordnergrenzen, `*` innerhalb eines Segments, sonst literal. */
export function globMatch(pattern: string, path: string): boolean {
	return toRegex(pattern).test(path);
}

const regexCache = new Map<string, RegExp>();
function toRegex(pattern: string): RegExp {
	const hit = regexCache.get(pattern);
	if (hit) return hit;
	let rx = '';
	let i = 0;
	while (i < pattern.length) {
		const c = pattern.charAt(i);
		if (c === '*') {
			if (pattern.startsWith('**/', i)) { rx += '(?:[^/]+/)*'; i += 3; continue; }
			if (pattern.startsWith('**', i)) { rx += '.*'; i += 2; continue; }
			rx += '[^/]*'; i += 1; continue;
		}
		rx += /[a-zA-Z0-9_\-/]/.test(c) ? c : `\\${c}`;
		i += 1;
	}
	const re = new RegExp(`^${rx}$`);
	regexCache.set(pattern, re);
	return re;
}

const fsPatternCache = new Map<string, string | null>();
function fsPattern(pattern: string): string | null {
	let hit = fsPatternCache.get(pattern);
	if (hit === undefined) {
		hit = filesystemPath(pattern);
		fsPatternCache.set(pattern, hit);
	}
	return hit;
}

/** Die Denylist ist eine Schreibgrenze, die einen Ordner BEWACHT. Ein Pfad zählt deshalb als gesperrt, wenn der Rohpfad ODER seine
 *  Dateisystem-Lesart (Kit `folder-scope`, `filesystemPath`) auf ein Muster passt, und die Muster werden nach denselben Segment-Regeln
 *  gelesen, sonst verglichen zwei verschiedene Schreibweisen: `_crews /x.md`, `_crews./x.md`, `_crews:s/x.md` und `_CREWS/x.md` sind auf
 *  der Platte `_crews/x.md` (Windows kappt Leerraum, Punkt und `:`-Suffix; APFS faltet die Schreibweise), liefen aber am Muster
 *  `_crews/**` vorbei (Welle 25). Die Lesart ist die weitere Seite, ein Wächter schützt nie weniger als zuvor. Die Whitelist (`write_scope`)
 *  bleibt bei der Textlesart: `Projekte /x.md` liegt nicht in `Projekte/**`, auch wenn Windows es dorthin legen würde. */
export function isDenied(path: string, denylist: string[]): boolean {
	const fs = filesystemPath(path);
	return denylist.some((d) => {
		if (globMatch(d, path)) return true;
		const fd = fsPattern(d);
		return fd !== null && (globMatch(fd, path) || (fs !== null && globMatch(fd, fs)));
	});
}

/** Target-Platzhalter: `{{today}}` → lokales YYYY-MM-DD (deterministisch aus nowMs); `{{input}}` → Pfad der Notiz, die ein
 *  `per_note`-Aufruf gerade bearbeitet. Ohne `inputPath` bleibt `{{input}}` stehen: der Parser verlangt `per_note: true`, und der
 *  Orchestrator löst ein solches Ziel nie auf. Der Pfad wird als Funktion eingesetzt, damit `$&` im Namen nichts ersetzt. */
export function expandTarget(template: string, nowMs: number, inputPath: string | null = null): string {
	const d = new Date(nowMs);
	const today = template.replaceAll('{{today}}', localDate(d));
	return inputPath === null ? today : today.replaceAll('{{input}}', () => inputPath);
}

const SAMPLE_DAY_MS = Date.UTC(2000, 0, 1, 12);

/** Prüft einen FESTEN Zielordner einer Crew-Datei (`notes.create`, `note.file`) beim Einlesen. Gemessen wird der Probepfad `<Ordner>/x.md`
 *  mit denselben Wächtern, die der Executor später auf den echten Pfad anwendet: Sperrliste (überstimmt alles) und `write_scope`. Gibt den
 *  Fehltext zurück (er nennt den Ordner und die Regel, die ihn trifft) oder `null`. Wirft nie: ein `..` oder NUL im Ordner ist ein Fehltext
 *  statt der Ausnahme von `normalizeVaultPath`. Der Platzhalter `{{today}}` ist erlaubt und wird für die Probe durch ein Beispieldatum ersetzt;
 *  jeder andere Platzhalter ist ein Fehler, ebenso die Vault-Wurzel und ein Glob-Zeichen (`*`). */
export function checkFixedFolder(folder: string, team: Pick<TeamDef, 'writeScope'>, denylist: string[]): string | null {
	const raw = folder.trim();
	const placeholder = /\{\{([^}]*)\}\}/.exec(raw.replaceAll('{{today}}', ''));
	if (placeholder !== null) return `'${raw}': der Platzhalter ${placeholder[0]} ist hier nicht erlaubt (nur {{today}})`;
	let norm: string;
	try {
		norm = normalizeVaultPath(raw);
	} catch {
		return `'${raw.replaceAll('\0', '\\0')}': ungültiger Ordner (".." und NUL sind nicht erlaubt)`;
	}
	if (norm === '') return `'${raw}': der Ordner fehlt oder ist die Vault-Wurzel (erwartet einen Ordner im Vault)`;
	if (norm.includes('*')) return `'${norm}': ein Ordner ist ein fester Name, kein Muster (kein *)`;
	const probe = `${expandTarget(norm, SAMPLE_DAY_MS)}/x.md`;
	if (isDenied(probe, denylist)) {
		const rule = denylist.find((d) => globMatch(d, probe));
		return `'${norm}' liegt in einem geschützten Bereich${rule === undefined ? '' : ` (Sperrliste: ${rule})`}`;
	}
	if (!team.writeScope.some((g) => globMatch(g, probe))) return `'${norm}' liegt außerhalb von write_scope (${team.writeScope.join(', ')})`;
	return null;
}
