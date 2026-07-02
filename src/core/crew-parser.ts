/** Parser + Preflight-Validierung für Agent-/Team-Definitionen aus dem Vault.
 *  Grundsatz (Spec §2.1/§3.1): ALLE Fehler sammeln, zeilenverständlich melden
 *  (`<datei>: <feld>: <problem>`), und zwar BEVOR irgendein LLM-Call passiert. */
import { globMatch } from './paths';
import type {
	ActionType, AgentDef, CollectorId, LlmTaskDef, RunLimits, SchemaId, TaskDef, TeamDef,
} from './types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const COLLECTORS: CollectorId[] = ['vault.list', 'vault.read', 'tasknotes.query'];
const SCHEMAS: SchemaId[] = ['triage-v1', 'briefing-v1'];
const ACTIONS: ActionType[] = ['frontmatter.patch', 'note.create', 'note.append', 'section.replace'];

function slugFromPath(path: string): string {
	const base = path.split('/').pop() ?? path;
	return base.replace(/\.md$/, '');
}

export function parseAgentDef(path: string, fm: Record<string, unknown> | null, body: string): ParseResult<AgentDef> {
	const errors: string[] = [];
	const err = (feld: string, problem: string): void => { errors.push(`${path}: ${feld}: ${problem}`); };
	if (fm === null) {
		return { ok: false, errors: [`${path}: frontmatter: fehlt (erwartet crew-kind: agent)`] };
	}
	if (fm['crew-kind'] !== 'agent') err('crew-kind', `'${show(fm['crew-kind'])}' (erwartet 'agent')`);
	const name = typeof fm.name === 'string' && fm.name.trim() !== '' ? fm.name.trim() : null;
	if (name === null) err('name', 'fehlt oder leer (erwartet nicht-leeren String)');
	const systemPrompt = body.trim();
	if (systemPrompt === '') err('systemPrompt', 'Note-Body ist leer (erwartet System-Prompt-Prosa)');

	const model = typeof fm.model === 'string' && fm.model.trim() !== '' ? fm.model.trim() : null;
	const temperature = typeof fm.temperature === 'number' ? fm.temperature : 0.1;
	const maxTokens = typeof fm.max_tokens === 'number' ? fm.max_tokens : 2048;
	const thinkingRaw = fm.thinking;
	const thinking = thinkingRaw === 'on' || thinkingRaw === 'off' || thinkingRaw === 'auto' ? thinkingRaw : 'auto';
	if (thinkingRaw !== undefined && thinking !== thinkingRaw) err('thinking', `'${show(thinkingRaw)}' (erwartet auto|on|off)`);

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: { id: slugFromPath(path), name: name ?? '', model, temperature, maxTokens, thinking, systemPrompt },
	};
}

export interface TeamParseOpts { knownAgents: string[]; maxima: RunLimits; denylist: string[]; }

export function parseTeamDef(path: string, fm: Record<string, unknown> | null, opts: TeamParseOpts): ParseResult<TeamDef> {
	const errors: string[] = [];
	const err = (feld: string, problem: string): void => { errors.push(`${path}: ${feld}: ${problem}`); };
	if (fm === null) {
		return { ok: false, errors: [`${path}: frontmatter: fehlt (erwartet crew-kind: team)`] };
	}
	if (fm['crew-kind'] !== 'team') err('crew-kind', `'${show(fm['crew-kind'])}' (erwartet 'team')`);
	const name = typeof fm.name === 'string' && fm.name.trim() !== '' ? fm.name.trim() : null;
	if (name === null) err('name', 'fehlt oder leer');
	if (fm.version !== 1) err('version', `'${show(fm.version)}' (erwartet 1)`);
	if (fm.trigger !== 'manual') err('trigger', `'${show(fm.trigger)}' (V1 unterstützt nur 'manual')`);
	const description = typeof fm.description === 'string' ? fm.description : '';

	const limits = isRecord(fm.limits) ? fm.limits : {};
	let maxWrites = typeof limits.max_writes === 'number' ? limits.max_writes : opts.maxima.maxWrites;
	if (maxWrites > opts.maxima.maxWrites) {
		err('limits.max_writes', `${maxWrites} überschreitet Plugin-Maximum ${opts.maxima.maxWrites}`);
		maxWrites = opts.maxima.maxWrites;
	}
	if (maxWrites < 0) err('limits.max_writes', `${maxWrites} (erwartet ≥ 0)`);

	const writeScope: string[] = [];
	if (!Array.isArray(fm.write_scope) || fm.write_scope.length === 0) {
		err('write_scope', 'fehlt oder leer (erwartet Glob-Liste)');
	} else {
		for (const g of fm.write_scope) {
			if (typeof g !== 'string' || g.trim() === '') { err('write_scope', `ungültiger Eintrag '${show(g)}'`); continue; }
			const glob = g.trim();
			// Whitelist darf die Denylist nicht anfassen: ein Scope, dessen Wurzel in einem
			// Denylist-Bereich liegt, ist immer ein Definitionsfehler.
			const root = glob.split('*')[0] ?? glob;
			if (opts.denylist.some((d) => globMatch(d, `${root.replace(/\/$/, '')}/x`) || globMatch(d, root))) {
				err('write_scope', `'${glob}' liegt in einem geschützten Bereich`);
				continue;
			}
			writeScope.push(glob);
		}
	}

	const tasks: TaskDef[] = [];
	if (!Array.isArray(fm.tasks) || fm.tasks.length === 0) {
		err('tasks', 'fehlt oder leer (erwartet mindestens einen Task)');
	} else {
		const seenIds = new Set<string>();
		const rawTasks: unknown[] = fm.tasks;
		for (let i = 0; i < rawTasks.length; i++) {
			const raw: unknown = rawTasks[i];
			const label = `tasks[${i}]`;
			if (!isRecord(raw)) { err(label, 'ist kein Objekt'); continue; }
			const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null;
			if (id === null) { err(`${label}.id`, 'fehlt oder leer'); continue; }
			if (seenIds.has(id)) err(`${label}.id`, `'${id}' doppelt (Task-IDs müssen eindeutig sein)`);
			const inputs = parseInputs(raw, `${label}.inputs`, seenIds, err);
			switch (raw.kind) {
				case 'collector': {
					const collector = COLLECTORS.includes(raw.collector as CollectorId) ? (raw.collector as CollectorId) : null;
					if (collector === null) { err(`${label}.collector`, `'${show(raw.collector)}' (erwartet ${COLLECTORS.join('|')})`); break; }
					tasks.push({ id, kind: 'collector', collector, params: isRecord(raw.params) ? raw.params : {} });
					break;
				}
				case 'llm': {
					const agent = typeof raw.agent === 'string' ? raw.agent : '';
					if (!opts.knownAgents.includes(agent)) err(`${label}.agent`, `'${agent}' unbekannt (vorhanden: ${opts.knownAgents.join(', ') || '—'})`);
					const instruction = typeof raw.instruction === 'string' && raw.instruction.trim() !== '' ? raw.instruction.trim() : null;
					if (instruction === null) err(`${label}.instruction`, 'fehlt oder leer');
					const schema = SCHEMAS.includes(raw.output_schema as SchemaId) ? (raw.output_schema as SchemaId) : null;
					if (schema === null) err(`${label}.output_schema`, `'${show(raw.output_schema)}' (erwartet ${SCHEMAS.join('|')})`);
					const onError = raw.on_error === 'skip' ? 'skip' : 'abort';
					if (raw.on_error !== undefined && raw.on_error !== 'skip' && raw.on_error !== 'abort') err(`${label}.on_error`, `'${show(raw.on_error)}' (erwartet abort|skip)`);
					const def: LlmTaskDef = { id, kind: 'llm', agent, inputs, instruction: instruction ?? '', outputSchema: schema ?? 'triage-v1', onError };
					tasks.push(def);
					break;
				}
				case 'actions': {
					const allowedActions: ActionType[] = [];
					if (!Array.isArray(raw.allowed_actions) || raw.allowed_actions.length === 0) {
						err(`${label}.allowed_actions`, 'fehlt oder leer');
					} else {
						for (const a of raw.allowed_actions) {
							if (ACTIONS.includes(a as ActionType)) allowedActions.push(a as ActionType);
							else err(`${label}.allowed_actions`, `'${show(a)}' (erwartet ${ACTIONS.join('|')})`);
						}
					}
					const allowedKeys = Array.isArray(raw.allowed_keys) ? raw.allowed_keys.filter((k): k is string => typeof k === 'string') : null;
					const target = typeof raw.target === 'string' && raw.target.trim() !== '' ? raw.target.trim() : null;
					tasks.push({ id, kind: 'actions', inputs, allowedActions, allowedKeys, target });
					break;
				}
				default:
					err(`${label}.kind`, `'${show(raw.kind)}' (erwartet collector|llm|actions)`);
			}
			seenIds.add(id);
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			id: slugFromPath(path), name: name ?? '', version: 1, description,
			trigger: 'manual', maxWrites, writeScope, tasks, sourcePath: path,
		},
	};
}

function parseInputs(
	raw: Record<string, unknown>,
	feld: string,
	earlierIds: Set<string>,
	err: (feld: string, problem: string) => void,
): string[] {
	if (raw.inputs === undefined) return [];
	if (!Array.isArray(raw.inputs)) { err(feld, 'ist keine Liste'); return []; }
	const out: string[] = [];
	for (const ref of raw.inputs) {
		if (typeof ref !== 'string') { err(feld, `ungültige Referenz '${show(ref)}'`); continue; }
		if (!earlierIds.has(ref)) { err(feld, `'${ref}' referenziert keinen FRÜHEREN Task`); continue; }
		out.push(ref);
	}
	return out;
}

/** Sichere Darstellung eines unknown-Werts in Fehlermeldungen (no-base-to-string). */
function show(v: unknown): string {
	return typeof v === 'string' ? v : JSON.stringify(v) ?? 'undefined';
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
