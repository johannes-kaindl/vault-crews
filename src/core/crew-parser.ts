/** Parser + Preflight-Validierung für Agent-/Team-Definitionen aus dem Vault.
 *  Grundsatz (Spec §2.1/§3.1): ALLE Fehler sammeln, zeilenverständlich melden
 *  (`<datei>: <feld>: <problem>`), und zwar BEVOR irgendein LLM-Call passiert. */
import { checkFixedFolder, isDenied, normalizeVaultPath } from './paths';
import { foldCase } from '../vendor/kit/fold-case';
import { normalizeRelPath } from '../vendor/kit/rel-path';
import { MIN_INTERVAL_MINUTES, parseIntervalMinutes } from './heartbeat';
import { VALUES_MAX } from './value-sources';
import type {
	ActionType, AgentDef, CollectorId, LlmTaskDef, OutputSpec, RunLimits, TaskDef, TeamDef, ValueSource,
} from './types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const COLLECTORS: CollectorId[] = ['vault.list', 'vault.read', 'tasknotes.query'];
/** Obergrenze von `max_chars` bei `text.append` (wie der Standard von `section.write`); Standard 4000. */
const MAX_OUTPUT_CHARS = 16_000;
const TEXT_APPEND_DEFAULT_CHARS = 4000;
const NOTES_CREATE_DEFAULT_ITEMS = 5;
/** Obergrenze von `max_items` bei `notes.create` (wie `MAX_TRIAGE_ITEMS` der Triage). */
const NOTES_CREATE_MAX_ITEMS = 50;
/** Ein Feldname im festen Frontmatter: ein Wort ohne `:`, `#`, Anführungszeichen und Zeilenumbruch, damit die Zeile `<name>: <wert>` stimmt. */
const FRONTMATTER_KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u;
const ACTIONS: ActionType[] = ['frontmatter.patch', 'note.create', 'note.append', 'section.replace'];

/** Schlüssel, unter dem zwei `target`-Angaben als dieselbe Datei gelten: `normalizeVaultPath` (`./`, `//`, `\`, führendes `/`) und `foldCase`
 *  (Groß-/Kleinschreibung, NFC), wie das Dateisystem sie vergleicht. Die Platzhalter `{{…}}` bleiben unverändert, nur der Text
 *  dazwischen wird gefaltet. Ein Pfad, den die Normalisierung ablehnt (`..`), bleibt im Rohtext. */
function targetKey(target: string): string {
	let norm = target;
	try { norm = normalizeVaultPath(target); } catch { /* bleibt Rohtext */ }
	return norm.split(/(\{\{[a-z]+\}\})/).map((part, i) => (i % 2 === 1 ? part : foldCase(part))).join('');
}

function slugFromPath(path: string): string {
	const base = path.split('/').pop() ?? path;
	return base.replace(/\.md$/, '');
}

/** Löst die Legacy-`output_schema:`-IDs auf ein OutputSpec auf. Einzige Stelle,
 *  an der triage-v1/briefing-v1 zu Familien werden. */
function resolveSchemaAlias(id: string): OutputSpec | null {
	switch (id) {
		case 'triage-v1': return { family: 'frontmatter.set', allowedKeys: '*', values: {}, addTo: [] };
		case 'briefing-v1': return { family: 'section.write', maxChars: 16_000, wording: 'briefing' };
		default: return null;
	}
}

/** `values:` an `frontmatter.set`: je Feld eine Wertemenge (`from: list|tags|notes`). Ein Feld muss in `allowed_keys` stehen. */
function parseValues(
	raw: unknown,
	feld: string,
	allowedKeys: string[],
	err: (feld: string, problem: string) => void,
	denylist: string[],
): Record<string, ValueSource> | null {
	if (raw === undefined) return {};
	if (!isRecord(raw)) { err(feld, 'ist keine Zuordnung (erwartet <feld>: { from: list|tags|notes })'); return null; }
	const out: Record<string, ValueSource> = {};
	let ok = true;
	for (const [key, entry] of Object.entries(raw)) {
		const f = `${feld}.${key}`;
		if (!allowedKeys.includes(key)) { err(f, `'${key}' steht nicht in allowed_keys (${allowedKeys.join(', ')})`); ok = false; continue; }
		if (!isRecord(entry)) { err(`${f}.from`, 'fehlt (erwartet list|tags|notes)'); ok = false; continue; }
		const from = entry.from;
		const stray = (names: string[]): void => {
			for (const n of names) if (entry[n] !== undefined) { err(`${f}.${n}`, `gilt nicht für from: ${String(from)}`); ok = false; }
		};
		if (from === 'tags') {
			stray(['list', 'folder']);
			out[key] = { kind: 'tags' };
		} else if (from === 'list') {
			stray(['folder']);
			const list = entry.list;
			if (!Array.isArray(list) || list.length === 0 || !list.every((v): v is string => typeof v === 'string' && v.trim() !== '')) {
				err(`${f}.list`, 'fehlt oder ist keine nicht-leere Liste von Texten');
				ok = false;
			} else if (list.length > VALUES_MAX) {
				err(`${f}.list`, `${list.length} Werte überschreiten das Maximum ${VALUES_MAX}`);
				ok = false;
			} else {
				out[key] = { kind: 'list', list: [...list] };
			}
		} else if (from === 'notes') {
			stray(['list']);
			const folder = typeof entry.folder === 'string' ? entry.folder.trim() : '';
			const rel = folder === '' ? null : normalizeRelPath(folder, { absolute: 'strip', allowEmpty: false });
			if (folder === '') {
				err(`${f}.folder`, 'fehlt oder leer (erwartet den Ordner, dessen Notizen die Werte sind)');
				ok = false;
			} else if (rel === null || !rel.ok || rel.path === '') {
				err(`${f}.folder`, `'${folder}' ist kein gültiger Ordner im Vault`);
				ok = false;
			} else if (isDenied(`${rel.path}/x.md`, denylist)) {
				err(`${f}.folder`, `'${rel.path}' liegt in einem geschützten Bereich`);
				ok = false;
			} else {
				out[key] = { kind: 'notes', folder: rel.path };
			}
		} else {
			err(`${f}.from`, `'${show(from)}' (erwartet list|tags|notes)`);
			ok = false;
		}
	}
	return ok ? out : null;
}

/** `add_to:` an `frontmatter.set`: Felder, deren Wert zur vorhandenen Liste hinzukommt statt sie zu ersetzen. */
function parseAddTo(
	raw: unknown,
	feld: string,
	allowedKeys: string[],
	err: (feld: string, problem: string) => void,
): string[] | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || !raw.every((k): k is string => typeof k === 'string' && k.trim() !== '')) {
		err(feld, 'ist keine Liste von Feldnamen');
		return null;
	}
	let ok = true;
	for (const k of raw) if (!allowedKeys.includes(k)) { err(feld, `'${k}' steht nicht in allowed_keys (${allowedKeys.join(', ')})`); ok = false; }
	return ok ? [...raw] : null;
}

/** `output: { family: notes.create }`: fester Ordner (läuft durch `checkFixedFolder`), festes Frontmatter, optional der Name des Feldes für den Quell-Link. */
function parseNotesCreate(
	raw: Record<string, unknown>,
	feld: string,
	err: (feld: string, problem: string) => void,
	denylist: string[],
	writeScope: string[],
): OutputSpec | null {
	let ok = true;
	if (raw.allowed_keys !== undefined) { err(`${feld}.allowed_keys`, 'gilt nur für frontmatter.set'); ok = false; }

	let folder = '';
	if (typeof raw.folder !== 'string' || raw.folder.trim() === '') {
		err(`${feld}.folder`, 'fehlt oder leer (erwartet den Ordner, in dem die Notizen entstehen)');
		ok = false;
	} else {
		const problem = checkFixedFolder(raw.folder, { writeScope }, denylist);
		if (problem !== null) { err(`${feld}.folder`, problem); ok = false; }
		else folder = normalizeVaultPath(raw.folder);
	}

	let maxItems = NOTES_CREATE_DEFAULT_ITEMS;
	if (raw.max_items !== undefined) {
		const m = raw.max_items;
		if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > NOTES_CREATE_MAX_ITEMS) {
			err(`${feld}.max_items`, `'${show(m)}' (erwartet ganze Zahl von 1 bis ${NOTES_CREATE_MAX_ITEMS})`);
			ok = false;
		} else {
			maxItems = m;
		}
	}

	const frontmatter: Record<string, string | number | string[]> = {};
	if (raw.frontmatter !== undefined) {
		if (!isRecord(raw.frontmatter)) {
			err(`${feld}.frontmatter`, 'ist keine Zuordnung (erwartet <feld>: <text|zahl|liste von texten>)');
			ok = false;
		} else {
			for (const [key, value] of Object.entries(raw.frontmatter)) {
				const f = `${feld}.frontmatter.${key}`;
				const oneLine = (v: unknown): v is string => typeof v === 'string' && !/[\r\n]/.test(v);
				if (!FRONTMATTER_KEY.test(key) || key !== key.trim()) {
					err(`${feld}.frontmatter`, `Feldname '${key}' ungültig (Buchstaben, Ziffern, _, - und Leerzeichen; ohne : # oder Zeilenumbruch)`);
					ok = false;
				} else if (oneLine(value) || (typeof value === 'number' && Number.isFinite(value))) {
					frontmatter[key] = value;
				} else if (Array.isArray(value) && value.every(oneLine)) {
					// Der Kit-Serializer schreibt Listen im Flow-Stil (`[a, b]`) und quotet weder `]` noch den leeren Text: solche Elemente ergäben kaputtes YAML.
					const bad = value.find((el) => el === '' || /[[\]{},]/.test(el));
					if (bad !== undefined) {
						err(f, `Listenelement '${show(bad)}' ungültig (nicht leer, ohne [ ] { } , im Element)`);
						ok = false;
					} else {
						frontmatter[key] = [...value];
					}
				} else {
					err(f, `'${show(value)}' (erwartet einzeiligen Text, Zahl oder Liste von einzeiligen Texten)`);
					ok = false;
				}
			}
		}
	}

	let linkSource: string | null = null;
	if (raw.link_source !== undefined) {
		const l = raw.link_source;
		if (typeof l !== 'string' || !FRONTMATTER_KEY.test(l) || l !== l.trim()) {
			err(`${feld}.link_source`, `'${show(l)}' (erwartet den Namen eines Frontmatter-Feldes, etwa quelle)`);
			ok = false;
		} else if (Object.hasOwn(frontmatter, l)) {
			err(`${feld}.link_source`, `'${l}' steht schon in frontmatter (das Feld bekäme zwei Werte)`);
			ok = false;
		} else {
			linkSource = l;
		}
	}
	return ok ? { family: 'notes.create', folder, maxItems, frontmatter, linkSource } : null;
}

/** Parst den neuen `output:`-Block einer llm-Task auf ein OutputSpec. */
function parseOutputBlock(
	raw: unknown,
	feld: string,
	err: (feld: string, problem: string) => void,
	denylist: string[],
	writeScope: string[],
): OutputSpec | null {
	if (!isRecord(raw)) { err(feld, 'ist kein Objekt (erwartet family: …)'); return null; }
	const family = raw.family;
	if (family === 'frontmatter.set') {
		if (!Array.isArray(raw.allowed_keys) || raw.allowed_keys.length === 0) {
			err(`${feld}.allowed_keys`, 'fehlt oder leer (erwartet nicht-leere String-Liste)');
			return null;
		}
		const keys = raw.allowed_keys.filter((k): k is string => typeof k === 'string');
		if (keys.length !== raw.allowed_keys.length) { err(`${feld}.allowed_keys`, 'enthält Nicht-String-Einträge'); return null; }
		const values = parseValues(raw.values, `${feld}.values`, keys, err, denylist);
		const addTo = parseAddTo(raw.add_to, `${feld}.add_to`, keys, err);
		return values === null || addTo === null ? null : { family: 'frontmatter.set', allowedKeys: keys, values, addTo };
	}
	if ((family === 'section.write' || family === 'text.append' || family === 'notes.create') && (raw.values !== undefined || raw.add_to !== undefined)) {
		err(`${feld}.${raw.values !== undefined ? 'values' : 'add_to'}`, 'gilt nur für frontmatter.set');
		return null;
	}
	if (family === 'section.write') {
		if (raw.allowed_keys !== undefined) { err(`${feld}.allowed_keys`, 'gilt nur für frontmatter.set'); return null; }
		const maxChars = typeof raw.max_chars === 'number' && raw.max_chars > 0 ? raw.max_chars : 16_000;
		return { family: 'section.write', maxChars, wording: 'neutral' };
	}
	if (family === 'text.append') {
		if (raw.allowed_keys !== undefined) { err(`${feld}.allowed_keys`, 'gilt nur für frontmatter.set'); return null; }
		let ok = true;
		let maxChars = TEXT_APPEND_DEFAULT_CHARS;
		if (raw.max_chars !== undefined) {
			const m = raw.max_chars;
			if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > MAX_OUTPUT_CHARS) {
				err(`${feld}.max_chars`, `'${show(m)}' (erwartet ganze Zahl von 1 bis ${MAX_OUTPUT_CHARS})`);
				ok = false;
			} else {
				maxChars = m;
			}
		}
		let heading: string | null = null;
		if (raw.heading !== undefined) {
			const h = typeof raw.heading === 'string' ? raw.heading.trim() : '';
			if (h === '' || /[\r\n]/.test(h)) {
				err(`${feld}.heading`, `'${show(raw.heading)}' (erwartet eine einzeilige, nicht leere Überschrift)`);
				ok = false;
			} else if (h.startsWith('#')) {
				err(`${feld}.heading`, `'${show(raw.heading)}' (die Überschrift ohne #, etwa „Verlauf“ statt „## Verlauf“)`);
				ok = false;
			} else {
				heading = h;
			}
		}
		return ok ? { family: 'text.append', maxChars, heading } : null;
	}
	if (family === 'notes.create') return parseNotesCreate(raw, feld, err, denylist, writeScope);
	err(`${feld}.family`, `'${show(family)}' (erwartet frontmatter.set|section.write|text.append|notes.create)`);
	return null;
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
	const temperature = typeof fm.temperature === 'number' ? fm.temperature : undefined;
	const maxTokens = typeof fm.max_tokens === 'number' ? fm.max_tokens : 2048;
	const thinkingRaw = fm.thinking;
	const thinking = thinkingRaw === 'on' || thinkingRaw === 'off' || thinkingRaw === 'auto' ? thinkingRaw : 'auto';
	if (thinkingRaw !== undefined && thinking !== thinkingRaw) err('thinking', `'${show(thinkingRaw)}' (erwartet auto|on|off)`);

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			id: slugFromPath(path), name: name ?? '', model, ...(temperature !== undefined ? { temperature } : {}),
			maxTokens, thinking, systemPrompt,
		},
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
	const trigger = fm.trigger === 'interval' ? 'interval' : 'manual';
	let intervalMinutes: number | null = null;
	if (fm.trigger === 'interval') {
		intervalMinutes = parseIntervalMinutes(fm.interval);
		if (intervalMinutes === null) err('interval', `'${show(fm.interval)}' (erwartet z. B. '30m', '2h', '1d'; mindestens ${MIN_INTERVAL_MINUTES}m)`);
	} else if (fm.trigger !== 'manual') {
		err('trigger', `'${show(fm.trigger)}' (erwartet 'manual' oder 'interval')`);
	}
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
			const raw = g.trim();
			// Ein `..`-Segment (auch mit Leerraum drumherum, auch mit `\` als Trenner) gehört in keinen write_scope: es
			// führt aus dem Vault hinaus oder an der Denylist vorbei, ein NUL-Byte ebenso. Vor der Denylist, damit die Meldung die Ursache nennt.
			const rel = normalizeRelPath(raw, { absolute: 'strip', allowEmpty: true });
			if (!rel.ok) {
				if (rel.problem === 'traversal') err('write_scope', `'${raw}': ".." ist in write_scope nicht erlaubt`);
				else if (rel.problem === 'nul') err('write_scope', `'${raw.replaceAll('\0', '\\0')}': NUL-Byte ist in write_scope nicht erlaubt`);
				else err('write_scope', `ungültiger Eintrag '${show(g)}'`);
				continue;
			}
			// Ein Eintrag, der zur Vault-Wurzel würde (`.`, `./`, `/`), meinte als Schreibgrenze den ganzen Vault: Definitionsfehler.
			if (rel.path === '') { err('write_scope', `ungültiger Eintrag '${show(g)}'`); continue; }
			// Gespeichert und geprüft wird die normalisierte Form (wie `normalizeVaultPath` den Pfad der Aktion): sonst trifft
			// `./a/**` oder `a\b/**` zur Laufzeit nie. Der Schutz der Denylist ändert das nicht, `isDenied` liest jede Schreibweise selbst.
			const glob = rel.path;
			// Whitelist darf die Denylist nicht anfassen: ein Scope, dessen Wurzel in einem
			// Denylist-Bereich liegt, ist immer ein Definitionsfehler.
			const root = glob.split('*')[0] ?? glob;
			if (isDenied(`${root.replace(/\/$/, '')}/x`, opts.denylist) || isDenied(root, opts.denylist)) {
				err('write_scope', `'${glob}' liegt in einem geschützten Bereich`);
				continue;
			}
			// Ein führender Trenner ist ein absoluter Pfad, `write_scope` ist vault-relativ: eine andere Absicht als `abs/**`, die
			// still umzudeuten gäbe Schreibrecht an einer Stelle, die der Autor nicht meinte. Nach der Denylist, die `/_crews/**` weiter benennt.
			if (/^[\\/]/.test(raw)) {
				err('write_scope', `ungültiger Eintrag '${raw}': absoluter Pfad, write_scope ist vault-relativ`);
				continue;
			}
			// Ein Ordner-Ende (`a/`, `a/**/`, `a/.`) traf als Rohglob nie einen Pfad (Pfade enden nicht auf `/`); die Normalisierung
			// ließe es fallen und gäbe dem Eintrag Wirkung. Sie gibt nie mehr Schreibrecht, als der Wortlaut hatte: Definitionsfehler.
			const last = (raw.split(/[\\/]/).pop() ?? '').trim();
			if (last === '' || last === '.') {
				err('write_scope', `'${raw}': abschließender Schrägstrich oder Punkt-Segment ist in write_scope nicht erlaubt`);
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
					const hasBlock = raw.output !== undefined;
					const hasLegacy = raw.output_schema !== undefined;
					let output: OutputSpec | null = null;
					if (hasBlock && hasLegacy) {
						err(`${label}.output`, 'nicht beide: output und output_schema gleichzeitig gesetzt');
					} else if (hasBlock) {
						output = parseOutputBlock(raw.output, `${label}.output`, err, opts.denylist, writeScope);
					} else if (hasLegacy) {
						output = resolveSchemaAlias(typeof raw.output_schema === 'string' ? raw.output_schema : '');
						if (output === null) err(`${label}.output_schema`, `'${show(raw.output_schema)}' (erwartet triage-v1|briefing-v1)`);
					} else {
						err(`${label}.output`, 'fehlt (erwartet output-Block oder output_schema)');
					}
					const onError = raw.on_error === 'skip' ? 'skip' : 'abort';
					if (raw.on_error !== undefined && raw.on_error !== 'skip' && raw.on_error !== 'abort') err(`${label}.on_error`, `'${show(raw.on_error)}' (erwartet abort|skip)`);
					if (raw.per_note !== undefined && typeof raw.per_note !== 'boolean') err(`${label}.per_note`, `'${show(raw.per_note)}' (erwartet true|false)`);
					const perNote = raw.per_note === true;
					if (output?.family === 'notes.create' && output.linkSource !== null && !perNote) {
						err(`${label}.output.link_source`, 'verlangt per_note: true am Modellschritt (ohne per_note gibt es keine einzelne Quellnotiz)');
					}
					const def: LlmTaskDef = { id, kind: 'llm', agent, inputs, instruction: instruction ?? '', output: output ?? { family: 'frontmatter.set', allowedKeys: '*', values: {}, addTo: [] }, onError, perNote };
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
					if (raw.create_if_missing !== undefined && typeof raw.create_if_missing !== 'boolean') {
						err(`${label}.create_if_missing`, `'${show(raw.create_if_missing)}' (erwartet true|false)`);
					}
					const createIfMissing = raw.create_if_missing === true;
					for (const m of inputs.map((i) => tasks.find((t) => t.id === i))) {
						if (m?.kind === 'llm' && m.output.family === 'notes.create' && !allowedActions.includes('note.create')) {
							err(`${label}.allowed_actions`, `'${m.id}' legt Notizen an (notes.create), der Schritt braucht note.create`);
						}
					}
					if (target !== null && target.includes('{{input}}')) {
						const models = inputs.map((i) => tasks.find((t) => t.id === i)).filter((t): t is LlmTaskDef => t?.kind === 'llm');
						if (models.length === 0 || models.some((m) => !m.perNote)) {
							err(`${label}.target`, '{{input}} verlangt per_note: true am Modellschritt');
						}
					}
					if (target !== null && allowedActions.includes('section.replace')) {
						const other = tasks.find((t) => t.kind === 'actions' && t.target !== null && targetKey(t.target) === targetKey(target) && t.allowedActions.includes('section.replace'));
						if (other !== undefined) {
							err(`${label}.target`, `'${target}' ist schon Ziel von section.replace im Schritt '${other.id}' (zwei Schritte würden denselben Abschnitt überschreiben)`);
						}
					}
					tasks.push({ id, kind: 'actions', inputs, allowedActions, allowedKeys, target, createIfMissing });
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
			trigger, ...(intervalMinutes !== null ? { intervalMinutes } : {}), maxWrites, writeScope, tasks, sourcePath: path,
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
