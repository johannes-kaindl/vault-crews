/** Zweiphasiger Aktions-Executor (Spec §4.3/§4.4) — die unumgehbare Stufe 2 des
 *  constrain-then-verify: Phase 1 validiert ALLE Aktionen (Pfad-Guards, Typ-Checks,
 *  Slug-Rück-Mapping, Stale-Hash, Schreiblimit), erst danach entscheidet die
 *  Konsistenz-Schwelle, und erst Phase 2 schreibt. Quelle: Plan-Detail-Anhang Tasks 9-11. */
import type {
	Action, ActionOutcome, ActionsTaskDef, CollectedFile, FmValue, RunLimits, SlugTableData, TeamDef,
} from './types';
import type { VaultPort } from './ports';
import { globMatch, isDenied, normalizeVaultPath } from './paths';
import { fnv1a } from './collectors';
import { foldCase } from '../vendor/kit/fold-case';

export interface ExecutorContext {
	team: TeamDef;
	task: ActionsTaskDef;
	limits: RunLimits;
	/** Pfade der Notizen, die dieser Lauf bisher geschrieben hat. `max_writes` zählt Notizen, nicht Aktionen: eine Aktion verbraucht
	 *  nur dann einen Schreibvorgang, wenn ihr Pfad weder hier noch in diesem Durchgang schon vorkommt. */
	writtenPaths: ReadonlySet<string>;
	sources: CollectedFile[];
	/** Slug-Tabellen der Input-Artefakte (key = Frontmatter-Key); für byte-genaues Rück-Mapping. */
	slugTables: Record<string, SlugTableData>;
	/** Denylist mit injiziertem configDir (buildDenylist) — überstimmt jede Whitelist. */
	denylist: string[];
	/** Copy-on-Write-Hook (Design-Spec §6): vor jedem ANGEWANDTEN Write mit dem
	 *  aufgelösten Pfad aufgerufen — der Orchestrator snapshottet hier den Pre-Image.
	 *  Ein Throw wird wie ein Write-Fehler behandelt (Aktion failed). Optional:
	 *  Tests/Läufe ohne Undo lassen ihn weg. */
	preWrite?: (path: string) => Promise<void>;
	/** Wie `preWrite`, aber für `note.move`: vor dem Verschieben mit altem und neuem Pfad aufgerufen (`preWrite` läuft für eine Verschiebung nicht).
	 *  Ein Throw heißt: die Aktion ist `failed`, die Notiz bleibt liegen. Optional: Tests/Läufe ohne Undo lassen ihn weg. */
	preMove?: (from: string, to: string) => Promise<void>;
	/** Bringt den Dateinamen (das letzte Segment, kein Pfad) einer vom Modell vorgeschlagenen neuen Notiz in die Namensrichtlinie des Vaults
	 *  (main.ts: `safeFileName` des Kits, erst die API des Plugins `filename-sanitizer`, sonst die Kit-Regeln). Läuft VOR Denylist und
	 *  write_scope, die also den bereinigten Pfad sehen. Optional: Tests und Umgebungen ohne Verdrahtung lassen ihn weg. Nur `note.create`
	 *  bildet einen Namen aus Modellvorschlag; das Ziel von `section.replace` nennt der Team-Autor. */
	safeName?: (segment: string) => string;
	/** Pfad → `fnv1a` des Inhalts, den dieser Lauf zuletzt selbst geschrieben hat. Ein späterer Schritt darf auf eine Notiz schreiben,
	 *  die ein früherer Schritt desselben Laufs verändert hat: ihr Stand gilt neben dem gesammelten als nicht veraltet. Eine fremde Änderung
	 *  (weder gesammelter noch eigener Stand) bleibt `stale`. Optional: Tests und Läufe ohne frühere Schreibschritte lassen es weg. */
	ownHashes?: ReadonlyMap<string, string>;
}

export const CREW_MARKER = (teamId: string): { start: string; end: string } => ({
	start: `<!-- crew:${teamId} -->`,
	end: `<!-- /crew:${teamId} -->`,
});

interface ValidatedAction {
	action: Action;
	path: string;
	/** Nur `note.move`: der normalisierte Zielpfad. */
	to: string;
	outcome: ActionOutcome | null; // null = Validierung bestanden, wird in Phase 2 angewendet
	mappedSet: Record<string, FmValue> | null; // rückgemappte Werte (frontmatter.patch)
	mappedAdd: Record<string, (string | number)[]> | null; // rückgemappte Werte, die zur Liste hinzukommen (frontmatter.patch)
}

function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

function outcomeOf(
	action: Action, result: 'rejected' | 'stale' | 'failed', reason: string, code?: ActionOutcome['code'],
): ActionOutcome {
	return code === undefined ? { action, result, reason } : { action, result, reason, code };
}

function findHeadingLine(lines: string[], heading: string): number {
	return lines.findIndex((l) => {
		const m = /^#{1,6}\s+(.*?)\s*$/.exec(l);
		return m !== null && m[1] === heading;
	});
}

/** Prüft einen Wert für ein Frontmatter-Feld (Größe, Wertemenge) und mappt Kurzformen auf die Originalwerte zurück. */
function mapFmValue(key: string, value: FmValue, ctx: ExecutorContext): { ok: true; value: FmValue } | { ok: false; reason: string } {
	const table = Object.hasOwn(ctx.slugTables, key) ? ctx.slugTables[key] : undefined;
	const tooBig = (el: string | number | null): boolean => typeof el === 'string' && byteLength(el) > ctx.limits.maxNoteBytes;
	const tooBigReason = `Wert für '${key}' überschreitet maxNoteBytes (${ctx.limits.maxNoteBytes})`;
	const unknownReason = (el: string): string => `Wert '${el}' für '${key}' nicht in enumerierter Wertemenge`;
	if (Array.isArray(value)) {
		const list: (string | number)[] = [];
		for (const el of value) {
			if (tooBig(el)) return { ok: false, reason: tooBigReason };
			if (typeof el === 'string' && table !== undefined) {
				const original = Object.hasOwn(table.fromSlug, el) ? table.fromSlug[el] : undefined;
				if (original === undefined) return { ok: false, reason: unknownReason(el) };
				list.push(original);
			} else {
				list.push(el);
			}
		}
		return { ok: true, value: list };
	}
	if (tooBig(value)) return { ok: false, reason: tooBigReason };
	if (typeof value === 'string' && table !== undefined) {
		const original = Object.hasOwn(table.fromSlug, value) ? table.fromSlug[value] : undefined;
		if (original === undefined) return { ok: false, reason: unknownReason(value) };
		return { ok: true, value: original };
	}
	return { ok: true, value };
}

async function validateAction(action: Action, ctx: ExecutorContext, vault: VaultPort): Promise<ValidatedAction> {
	const v: ValidatedAction = { action, path: '', to: '', outcome: null, mappedSet: null, mappedAdd: null };

	// 1. Pfad-Normalisierung — '..' ist hart verboten
	try {
		v.path = normalizeVaultPath(action.path);
	} catch {
		v.outcome = outcomeOf(action, 'rejected', `Pfad ungültig ('..' oder NUL): ${action.path}`);
		return v;
	}
	// 1b. Der Dateiname einer neuen Notiz ist ein Modellvorschlag: durch die Namensrichtlinie, bevor die Wächter ihn sehen.
	if (action.type === 'note.create' && ctx.safeName !== undefined) {
		const slash = v.path.lastIndexOf('/');
		const name = ctx.safeName(v.path.slice(slash + 1));
		// Ein Sanitizer (auch ein Fremdplugin) liefert ein Segment; alles andere ist kein Dateiname und schreibt nichts.
		if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
			v.outcome = outcomeOf(action, 'rejected', `Dateiname von der Namensrichtlinie nicht brauchbar: ${action.path}`);
			return v;
		}
		v.path = `${v.path.slice(0, slash + 1)}${name}`;
	}
	// 2. Denylist überstimmt jede Whitelist
	if (isDenied(v.path, ctx.denylist)) {
		v.outcome = outcomeOf(action, 'rejected', `Pfad auf Denylist: ${v.path}`);
		return v;
	}
	// 3. write_scope-Whitelist des Teams
	if (!ctx.team.writeScope.some((g) => globMatch(g, v.path))) {
		v.outcome = outcomeOf(action, 'rejected', `Pfad außerhalb write_scope: ${v.path}`);
		return v;
	}
	// 4. Aktionstyp + typspezifische Checks
	if (!ctx.task.allowedActions.includes(action.type)) {
		v.outcome = outcomeOf(action, 'rejected', `Aktionstyp nicht in allowed_actions: ${action.type}`);
		return v;
	}
	if (action.type === 'note.move') {
		// Quelle und Ziel laufen durch dieselben Wächter; die Quelle ist `action.path` und hat die Schritte 1 bis 3 schon passiert.
		try {
			v.to = normalizeVaultPath(action.to);
		} catch {
			v.outcome = outcomeOf(action, 'rejected', `Zielpfad ungültig ('..' oder NUL): ${action.to}`);
			return v;
		}
		if (isDenied(v.to, ctx.denylist)) {
			v.outcome = outcomeOf(action, 'rejected', `Ziel auf Denylist: ${v.to}`);
			return v;
		}
		if (!ctx.team.writeScope.some((g) => globMatch(g, v.to))) {
			v.outcome = outcomeOf(action, 'rejected', `Ziel außerhalb write_scope: ${v.to}`);
			return v;
		}
		if (!v.path.endsWith('.md') || !v.to.endsWith('.md')) {
			v.outcome = outcomeOf(action, 'rejected', `nur .md-Dateien erlaubt: ${v.path} → ${v.to}`);
			return v;
		}
		if (!(await vault.exists(v.path))) {
			v.outcome = outcomeOf(action, 'failed', `Quelle existiert nicht: ${v.path}`);
			return v;
		}
		const slash = v.to.lastIndexOf('/');
		if (slash > 0 && !(await vault.exists(v.to.slice(0, slash)))) {
			v.outcome = outcomeOf(action, 'rejected', `Zielordner existiert nicht (wird nicht angelegt): ${v.to.slice(0, slash)}`);
			return v;
		}
		if (await vault.exists(v.to)) {
			v.outcome = outcomeOf(action, 'rejected', `Zielpfad belegt — note.move überschreibt nie: ${v.to}`);
			return v;
		}
	} else if (action.type === 'frontmatter.patch') {
		const keys = [...Object.keys(action.set), ...action.remove, ...Object.keys(action.add ?? {})];
		const allowed = ctx.task.allowedKeys ?? [];
		const badKey = keys.find((k) => !allowed.includes(k));
		if (badKey !== undefined) {
			v.outcome = outcomeOf(action, 'rejected', `Key nicht in allowed_keys: ${badKey}`);
			return v;
		}
		// set und add laufen durch dieselbe Prüfung: Größe, Wertemenge, Rück-Mapping der Kurzformen auf die Originalwerte.
		const mapped: Record<string, FmValue> = {};
		for (const [key, value] of Object.entries(action.set)) {
			const r = mapFmValue(key, value, ctx);
			if (!r.ok) { v.outcome = outcomeOf(action, 'rejected', r.reason); return v; }
			mapped[key] = r.value;
		}
		let mappedAdd: Record<string, (string | number)[]> | null = null;
		for (const [key, list] of Object.entries(action.add ?? {})) {
			const r = mapFmValue(key, list, ctx);
			if (!r.ok) { v.outcome = outcomeOf(action, 'rejected', r.reason); return v; }
			mappedAdd ??= {};
			mappedAdd[key] = r.value as (string | number)[];
		}
		v.mappedAdd = mappedAdd;
		if (!(await vault.exists(v.path))) {
			v.outcome = outcomeOf(action, 'failed', `Datei existiert nicht: ${v.path}`);
			return v;
		}
		v.mappedSet = mapped;
	} else if (action.type === 'note.create') {
		if (!v.path.endsWith('.md')) {
			v.outcome = outcomeOf(action, 'rejected', `nur .md-Dateien erlaubt: ${v.path}`);
			return v;
		}
		if (await vault.exists(v.path)) {
			v.outcome = outcomeOf(action, 'rejected', `existiert bereits — note.create überschreibt nie: ${v.path}`, 'exists');
			return v;
		}
		if (byteLength(action.content) > ctx.limits.maxNoteBytes) {
			v.outcome = outcomeOf(action, 'rejected', `content überschreitet maxNoteBytes (${ctx.limits.maxNoteBytes})`);
			return v;
		}
	} else if (action.type === 'note.append') {
		if (!(await vault.exists(v.path))) {
			v.outcome = outcomeOf(action, 'failed', `Ziel existiert nicht: ${v.path} — zuerst anlegen`);
			return v;
		}
		if (byteLength(action.content) > ctx.limits.maxNoteBytes) {
			v.outcome = outcomeOf(action, 'rejected', `content überschreitet maxNoteBytes (${ctx.limits.maxNoteBytes})`);
			return v;
		}
		if (action.heading !== null) {
			const current = await vault.read(v.path);
			if (findHeadingLine(current.split('\n'), action.heading) === -1) {
				v.outcome = outcomeOf(action, 'failed', `Heading '${action.heading}' nicht gefunden in ${v.path}`);
				return v;
			}
		}
	} else {
		// section.replace
		if (!(await vault.exists(v.path)) && ctx.task.createIfMissing !== true) {
			v.outcome = outcomeOf(action, 'failed', `Ziel existiert nicht: ${v.path} — zuerst anlegen (create_if_missing: false)`);
			return v;
		}
		const marker = CREW_MARKER(ctx.team.id);
		if (action.content.includes(marker.start) || action.content.includes(marker.end)) {
			v.outcome = outcomeOf(action, 'rejected', `content enthält Crew-Marker — abgelehnt zum Schutz vor Marker-Injection`);
			return v;
		}
		if (byteLength(action.content) > ctx.limits.maxNoteBytes) {
			v.outcome = outcomeOf(action, 'rejected', `content überschreitet maxNoteBytes (${ctx.limits.maxNoteBytes})`);
			return v;
		}
	}
	// 5. Stale-Guard: nur wo die Datei im Quellmaterial liegt; note.create ausgenommen
	if (action.type !== 'note.create') {
		const src = ctx.sources.find((f) => f.path === v.path);
		if (src !== undefined) {
			let current: string;
			try {
				current = await vault.read(v.path);
			} catch {
				// Die Datei verschwand zwischen der Existenzprüfung (oder ihrem Auslassen bei create_if_missing) und dem Lesen.
				v.outcome = outcomeOf(action, 'failed', `Datei nicht mehr vorhanden: ${v.path}`);
				return v;
			}
			const hash = fnv1a(current);
			if (hash !== src.contentHash && hash !== ctx.ownHashes?.get(v.path)) {
				v.outcome = { action, result: 'stale', reason: `Datei seit Collect geändert: ${v.path}` };
				return v;
			}
		}
	}
	return v;
}

function appendContent(current: string, heading: string | null, content: string): string {
	const block = content.endsWith('\n') ? content : `${content}\n`;
	if (heading === null) {
		const base = current === '' || current.endsWith('\n') ? current : `${current}\n`;
		return base + block;
	}
	const lines = current.split('\n');
	const start = findHeadingLine(lines, heading);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i] ?? '')) {
			end = i;
			break;
		}
	}
	let insertAt = end;
	while (insertAt > start + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;
	return [...lines.slice(0, insertAt), ...content.split('\n'), ...lines.slice(insertAt)].join('\n');
}

function replaceSection(current: string, teamId: string, content: string): string {
	const { start, end } = CREW_MARKER(teamId);
	const si = current.indexOf(start);
	if (si === -1) {
		// Ein einsamer End-Marker ohne Start ist beschädigt; sonst frischer Block ans Ende.
		const strayEnd = current.indexOf(end);
		if (strayEnd !== -1) {
			throw new Error(`Crew-Marker beschädigt (start=${si}, end=${strayEnd}) — Block manuell reparieren`);
		}
		const base = current === '' || current.endsWith('\n') ? current : `${current}\n`;
		return `${base}\n${start}\n${content}\n${end}\n`;
	}
	// End-Marker NACH dem Start suchen — verhindert, dass ein in den content
	// eingebetteter (bei validateAction abgelehnter, aber defense-in-depth
	// trotzdem hier abgesichert) Marker-String vom vorigen Lauf als Ende gefunden wird.
	const ei = current.indexOf(end, si + start.length);
	if (ei === -1) {
		throw new Error(`Crew-Marker beschädigt (start=${si}, end=${ei}) — Block manuell reparieren`);
	}
	return `${current.slice(0, si + start.length)}\n${content}\n${current.slice(ei)}`;
}

async function applyAction(v: ValidatedAction, ctx: ExecutorContext, vault: VaultPort): Promise<void> {
	const action = v.action;
	if (action.type === 'frontmatter.patch') {
		if (v.mappedAdd !== null) await vault.patchFrontmatter(v.path, v.mappedSet ?? {}, action.remove, v.mappedAdd);
		else await vault.patchFrontmatter(v.path, v.mappedSet ?? {}, action.remove);
	} else if (action.type === 'note.move') {
		await vault.rename(v.path, v.to);
	} else if (action.type === 'note.create') {
		const slash = v.path.lastIndexOf('/');
		if (slash > 0) await vault.mkdir(v.path.slice(0, slash)); // wie bei section.replace: mkdir ist idempotent + rekursiv (VaultPort); Wurzelziele legen keinen Ordner an
		await vault.create(v.path, action.content);
	} else if (action.type === 'note.append') {
		const current = await vault.read(v.path);
		await vault.modify(v.path, appendContent(current, action.heading, action.content));
	} else {
		if (!(await vault.exists(v.path))) {
			const slash = v.path.lastIndexOf('/');
			if (slash > 0) await vault.mkdir(v.path.slice(0, slash)); // mkdir ist idempotent + rekursiv (VaultPort)
			// replaceSection('') erzeugt einen führenden Zeilenumbruch (Append-Semantik) —
			// im frisch angelegten File unerwünscht, daher strippen.
			await vault.create(v.path, replaceSection('', ctx.team.id, action.content).replace(/^\n/, ''));
			return;
		}
		const current = await vault.read(v.path);
		await vault.modify(v.path, replaceSection(current, ctx.team.id, action.content));
	}
}

export async function executeActions(
	actions: Action[],
	ctx: ExecutorContext,
	vault: VaultPort,
): Promise<{ outcomes: ActionOutcome[]; writes: string[]; moves: { from: string; to: string }[]; taskFailed: boolean }> {
	let taskFailed = false;

	// Phase 1: ALLE Aktionen validieren, bevor irgendetwas geschrieben wird.
	// Pfade werden gefaltet verglichen (Kit foldCase): auf macOS und Windows sind `Angebot.md` und `angebot.md` dieselbe Datei.
	const validated: ValidatedAction[] = [];
	const budgeted = new Set<string>(); // Notizen, die in diesem Durchgang schon einen Schreibvorgang verbrauchen
	const plannedCreates = new Set<string>();
	const plannedTargets = new Set<string>();   // Pfade, die in diesem Durchgang neu belegt werden (note.create, Ziel von note.move)
	const plannedMoveSources = new Set<string>();
	const alreadyWritten = new Set([...ctx.writtenPaths].map(foldCase));
	for (const action of actions) {
		const v = await validateAction(action, ctx, vault);
		if (v.outcome === null) {
			const key = foldCase(v.path);
			const targetKey = action.type === 'note.move' ? foldCase(v.to) : key;
			if (action.type === 'note.create' && plannedCreates.has(key)) {
				v.outcome = outcomeOf(action, 'rejected', `derselbe Pfad zweimal in einem Durchgang: ${v.path}`, 'duplicate');
			} else if (action.type === 'note.move' && plannedMoveSources.has(key)) {
				// Ohne `code`: nur Ablehnungen von note.create nehmen sich aus der Konsistenz-Schwelle.
				v.outcome = outcomeOf(action, 'rejected', `dieselbe Quelle zweimal verschoben in einem Durchgang: ${v.path}`);
			} else if ((action.type === 'note.move' || action.type === 'note.create') && plannedTargets.has(targetKey)) {
				v.outcome = outcomeOf(action, 'rejected', `derselbe Zielpfad zweimal in einem Durchgang: ${action.type === 'note.move' ? v.to : v.path}`);
			} else if (!alreadyWritten.has(key) && !budgeted.has(key) && alreadyWritten.size + budgeted.size + 1 > ctx.team.maxWrites) {
				// 6. Schreiblimit (Notizen aus dem Lauf + in diesem Task budgetierte Notizen)
				v.outcome = outcomeOf(action, 'rejected', `write_limit: max_writes (${ctx.team.maxWrites}) erreicht`);
				taskFailed = true;
			} else {
				budgeted.add(key);
				if (action.type === 'note.create') { plannedCreates.add(key); plannedTargets.add(key); }
				if (action.type === 'note.move') { plannedMoveSources.add(key); plannedTargets.add(targetKey); }
			}
		} else if (v.outcome.result === 'failed') {
			taskFailed = true;
		}
		validated.push(v);
	}

	// Konsistenz-Schwelle: > 50 % rejected/stale → Task-Fail, KEINE Aktion anwenden.
	// Ablehnungen mit `code` (Titel belegt, Titel doppelt) zählen weder im Zähler noch im Nenner.
	const counted = validated.filter((v) => v.outcome?.code === undefined);
	const invalidCount = counted.filter(
		(v) => v.outcome !== null && (v.outcome.result === 'rejected' || v.outcome.result === 'stale'),
	).length;
	if (counted.length > 0 && invalidCount * 2 > counted.length) {
		taskFailed = true;
		for (const v of validated) {
			if (v.outcome === null) {
				v.outcome = outcomeOf(v.action, 'rejected', 'consistency: > 50% der Aktionen rejected/stale — keine Aktion angewendet');
			}
		}
	}

	// Phase 2: anwenden.
	const outcomes: ActionOutcome[] = [];
	const writes: string[] = [];
	const moves: { from: string; to: string }[] = [];
	for (const v of validated) {
		if (v.outcome !== null) {
			outcomes.push(v.outcome);
			continue;
		}
		try {
			// Pre-Image sichern, BEVOR geschrieben wird; eine Verschiebung hat ihren eigenen Haken (altes und neues Ziel).
			if (v.action.type === 'note.move') await ctx.preMove?.(v.path, v.to);
			else await ctx.preWrite?.(v.path);
			await applyAction(v, ctx, vault);
			if (!writes.includes(v.path)) writes.push(v.path);
			if (v.action.type === 'note.move') moves.push({ from: v.path, to: v.to });
			outcomes.push({ action: v.action, result: 'applied', reason: null });
		} catch (e) {
			taskFailed = true;
			outcomes.push(outcomeOf(v.action, 'failed', `io: ${e instanceof Error ? e.message : String(e)}`));
		}
	}
	return { outcomes, writes, moves, taskFailed };
}
