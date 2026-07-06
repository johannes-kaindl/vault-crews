/** Zweiphasiger Aktions-Executor (Spec §4.3/§4.4) — die unumgehbare Stufe 2 des
 *  constrain-then-verify: Phase 1 validiert ALLE Aktionen (Pfad-Guards, Typ-Checks,
 *  Slug-Rück-Mapping, Stale-Hash, Schreiblimit), erst danach entscheidet die
 *  Konsistenz-Schwelle, und erst Phase 2 schreibt. Quelle: Plan-Detail-Anhang Tasks 9-11. */
import type {
	Action, ActionOutcome, ActionsTaskDef, CollectedFile, RunLimits, SlugTableData, TeamDef,
} from './types';
import type { VaultPort } from './ports';
import { globMatch, isDenied, normalizeVaultPath } from './paths';
import { fnv1a } from './collectors';

export interface ExecutorContext {
	team: TeamDef;
	task: ActionsTaskDef;
	limits: RunLimits;
	writeCount: number;
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
}

export const CREW_MARKER = (teamId: string): { start: string; end: string } => ({
	start: `<!-- crew:${teamId} -->`,
	end: `<!-- /crew:${teamId} -->`,
});

interface ValidatedAction {
	action: Action;
	path: string;
	outcome: ActionOutcome | null; // null = Validierung bestanden, wird in Phase 2 angewendet
	mappedSet: Record<string, string | number | null> | null; // rückgemappte Werte (frontmatter.patch)
}

function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

function outcomeOf(action: Action, result: 'rejected' | 'stale' | 'failed', reason: string): ActionOutcome {
	return { action, result, reason };
}

function findHeadingLine(lines: string[], heading: string): number {
	return lines.findIndex((l) => {
		const m = /^#{1,6}\s+(.*?)\s*$/.exec(l);
		return m !== null && m[1] === heading;
	});
}

async function validateAction(action: Action, ctx: ExecutorContext, vault: VaultPort): Promise<ValidatedAction> {
	const v: ValidatedAction = { action, path: '', outcome: null, mappedSet: null };

	// 1. Pfad-Normalisierung — '..' ist hart verboten
	try {
		v.path = normalizeVaultPath(action.path);
	} catch {
		v.outcome = outcomeOf(action, 'rejected', `Pfad enthält '..': ${action.path}`);
		return v;
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
	if (action.type === 'frontmatter.patch') {
		const keys = [...Object.keys(action.set), ...action.remove];
		const allowed = ctx.task.allowedKeys ?? [];
		const badKey = keys.find((k) => !allowed.includes(k));
		if (badKey !== undefined) {
			v.outcome = outcomeOf(action, 'rejected', `Key nicht in allowed_keys: ${badKey}`);
			return v;
		}
		const mapped: Record<string, string | number | null> = {};
		for (const [key, value] of Object.entries(action.set)) {
			if (typeof value === 'string' && byteLength(value) > ctx.limits.maxNoteBytes) {
				v.outcome = outcomeOf(action, 'rejected', `Wert für '${key}' überschreitet maxNoteBytes (${ctx.limits.maxNoteBytes})`);
				return v;
			}
			const table = ctx.slugTables[key];
			if (typeof value === 'string' && table !== undefined) {
				const original = table.fromSlug[value];
				if (original === undefined) {
					v.outcome = outcomeOf(action, 'rejected', `Wert '${value}' für '${key}' nicht in enumerierter Wertemenge`);
					return v;
				}
				mapped[key] = original;
			} else {
				mapped[key] = value;
			}
		}
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
			v.outcome = outcomeOf(action, 'rejected', `existiert bereits — note.create überschreibt nie: ${v.path}`);
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
		if (!(await vault.exists(v.path))) {
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
			const current = await vault.read(v.path);
			if (fnv1a(current) !== src.contentHash) {
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
		await vault.patchFrontmatter(v.path, v.mappedSet ?? {}, action.remove);
	} else if (action.type === 'note.create') {
		await vault.create(v.path, action.content);
	} else if (action.type === 'note.append') {
		const current = await vault.read(v.path);
		await vault.modify(v.path, appendContent(current, action.heading, action.content));
	} else {
		const current = await vault.read(v.path);
		await vault.modify(v.path, replaceSection(current, ctx.team.id, action.content));
	}
}

export async function executeActions(
	actions: Action[],
	ctx: ExecutorContext,
	vault: VaultPort,
): Promise<{ outcomes: ActionOutcome[]; writes: string[]; taskFailed: boolean }> {
	let taskFailed = false;

	// Phase 1: ALLE Aktionen validieren, bevor irgendetwas geschrieben wird.
	const validated: ValidatedAction[] = [];
	let budgetUsed = 0;
	for (const action of actions) {
		const v = await validateAction(action, ctx, vault);
		if (v.outcome === null) {
			// 6. Schreiblimit (writeCount aus dem Lauf + in diesem Task budgetierte Writes)
			if (ctx.writeCount + budgetUsed + 1 > ctx.team.maxWrites) {
				v.outcome = outcomeOf(action, 'rejected', `write_limit: max_writes (${ctx.team.maxWrites}) erreicht`);
				taskFailed = true;
			} else {
				budgetUsed += 1;
			}
		} else if (v.outcome.result === 'failed') {
			taskFailed = true;
		}
		validated.push(v);
	}

	// Konsistenz-Schwelle: > 50 % rejected/stale → Task-Fail, KEINE Aktion anwenden.
	const invalidCount = validated.filter(
		(v) => v.outcome !== null && (v.outcome.result === 'rejected' || v.outcome.result === 'stale'),
	).length;
	if (actions.length > 0 && invalidCount * 2 > actions.length) {
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
	for (const v of validated) {
		if (v.outcome !== null) {
			outcomes.push(v.outcome);
			continue;
		}
		try {
			if (ctx.preWrite) await ctx.preWrite(v.path); // Pre-Image sichern, BEVOR geschrieben wird
			await applyAction(v, ctx, vault);
			if (!writes.includes(v.path)) writes.push(v.path);
			outcomes.push({ action: v.action, result: 'applied', reason: null });
		} catch (e) {
			taskFailed = true;
			outcomes.push(outcomeOf(v.action, 'failed', `io: ${e instanceof Error ? e.message : String(e)}`));
		}
	}
	return { outcomes, writes, taskFailed };
}
