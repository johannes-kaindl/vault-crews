import { localDate } from '../vendor/kit/local-stamp';
import { filesystemPath } from '../vendor/kit/folder-scope';
import { normalizeRelPath } from '../vendor/kit/rel-path';

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

/** Einziger Target-Platzhalter: {{today}} → lokales YYYY-MM-DD (deterministisch aus nowMs). */
export function expandTarget(template: string, nowMs: number): string {
	const d = new Date(nowMs);
	return template.replaceAll('{{today}}', localDate(d));
}
