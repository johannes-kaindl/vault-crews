/** Eingebaute, versionierte Output-Schemata (Spec §3.4): bewusst KEINE user-definierbare
 *  Schema-DSL in V1 und kein Ajv (eval-Compile). Jedes Schema validiert das LLM-JSON UND
 *  erzeugt daraus die deterministische Aktionsliste — ein einziger Übergabepunkt.
 *  Quellbindung macht Pfad-Halluzination strukturell unmöglich; Slug-Rück-Mapping passiert
 *  HIER (der Executor kennt keine SlugTables, Skelett-ExecutorContext). */
import { serializeFrontmatter, wikilinkOf } from '../vendor/kit/frontmatter';
import { expandTarget } from './paths';
import type { Action, CollectedFile, Destination, FmValue, FrontmatterPatchAction, NoteCreateAction, NoteMoveAction, OutputSpec, SchemaId, SlugTableData } from './types';

export interface SchemaDef {
	/** Familien-/Alias-Kennung (extern nicht gelesen; rein zur Selbstbeschreibung). */
	id: string;
	/** 'json': Modell antwortet mit einem ```json-Block, validate() bekommt das geparste Objekt.
	 *  'text': Modell antwortet mit rohem Text (kein JSON-Wrapping) — validate() bekommt den
	 *  bereits extrahierten String. JSON-Wrapping bietet für ein einzelnes Freitext-Feld keinen
	 *  Validierungsgewinn und ist genau der Anlass für den briefing-v1-Bug (Spec-Notiz unten). */
	outputFormat: 'json' | 'text';
	/** "So antwortest du"-Zeile für den System-Prompt — pro Schema, nicht mehr hartkodiert. */
	promptContract: string;
	/** One-Shot-Minimalbeispiel für den Prompt — bei kleinen Modellen wirksamer als Schema-Prosa. */
	outputExample: string;
	validate(
		json: unknown,
		sources: CollectedFile[],
		slugTables: Record<string, SlugTableData>,
		target: string | null,
	): { ok: true; actions: Action[] } | { ok: false; errors: string[] };
}

const MAX_TRIAGE_ITEMS = 50;

/** `addTo`: Felder, deren Wert zur vorhandenen Liste hinzukommt (Aktion `add`) statt sie zu ersetzen (`set`); ein Einzelwert gilt als
 *  einelementige Liste. Die Wertemenge (`slugTables`) prüft in beiden Fällen jedes Element: ein Tag, den es im Vault nicht gibt, ist ein Fehler. */
export function makeFrontmatterSet(allowedKeys: string[] | '*', addTo: string[] = []): SchemaDef {
	return {
		id: 'frontmatter.set',
		outputFormat: 'json',
		promptContract:
			'Antworte ausschließlich mit einem JSON-Objekt in einem ```json-Block, keine Erklärungen davor oder danach.',
		outputExample: '{"items": [{"path": "Aufgaben/beispiel.md", "set": {"priority": "mittel", "tags": ["arbeit", "notiz"]}}]}',
		validate(json, sources, slugTables, _target) {
			const errors: string[] = [];
			if (!isRecord(json) || !Array.isArray(json.items)) {
				return { ok: false, errors: ['items: fehlt oder ist keine Liste'] };
			}
			const items: unknown[] = json.items;
			if (items.length > MAX_TRIAGE_ITEMS) errors.push(`items: ${items.length} überschreitet Maximum ${MAX_TRIAGE_ITEMS}`);
			const knownPaths = new Set(sources.map((s) => s.path));
			const actions: FrontmatterPatchAction[] = [];
			for (let i = 0; i < items.length; i++) {
				const item: unknown = items[i];
				if (!isRecord(item)) { errors.push(`items[${i}]: ist kein Objekt`); continue; }
				const path = typeof item.path === 'string' ? item.path : null;
				if (path === null) { errors.push(`items[${i}].path: fehlt`); continue; }
				if (!knownPaths.has(path)) {
					errors.push(`items[${i}].path: '${path}' kommt im Quellmaterial nicht vor (Quellbindung)`);
					continue;
				}
				if (!isRecord(item.set)) { errors.push(`items[${i}].set: fehlt oder ist kein Objekt`); continue; }
				const set: Record<string, FmValue> = {};
				const add: Record<string, (string | number)[]> = {};
				for (const [key, rawValue] of Object.entries(item.set)) {
					if (allowedKeys !== '*' && !allowedKeys.includes(key)) {
						errors.push(`items[${i}].set.${key}: Feld nicht in allowed_keys (${allowedKeys.join(', ')})`);
						continue;
					}
					const adding = addTo.includes(key);
					const table = Object.hasOwn(slugTables, key) ? slugTables[key] : undefined;
					if (Array.isArray(rawValue)) {
						const list: (string | number)[] = [];
						let bad = false;
						for (const el of rawValue) {
							if (table) {
								if (typeof el !== 'string' || !Object.hasOwn(table.fromSlug, el)) {
									errors.push(`items[${i}].set.${key}: '${String(el)}' ist kein erlaubter Wert (${Object.keys(table.fromSlug).sort().join(', ')})`);
									bad = true;
									break;
								}
								list.push(el);
							} else if (typeof el === 'string' || typeof el === 'number') {
								list.push(el);
							} else {
								errors.push(`items[${i}].set.${key}: unzulässiges Listen-Element '${String(el)}'`);
								bad = true;
								break;
							}
						}
						if (!bad) { if (adding) add[key] = list; else set[key] = list; }
						continue;
					}
					if (table) {
						if (typeof rawValue !== 'string' || !Object.hasOwn(table.fromSlug, rawValue)) {
							errors.push(`items[${i}].set.${key}: '${String(rawValue)}' ist kein erlaubter Wert (${Object.keys(table.fromSlug).sort().join(', ')})`);
							continue;
						}
						if (adding) add[key] = [rawValue]; else set[key] = rawValue;
						continue;
					}
					if (adding) {
						if (typeof rawValue === 'string' || typeof rawValue === 'number') add[key] = [rawValue];
						else errors.push(`items[${i}].set.${key}: unzulässiger Werttyp (das Feld wird ergänzt, erwartet Text, Zahl oder Liste)`);
						continue;
					}
					if (typeof rawValue === 'string' || typeof rawValue === 'number' || rawValue === null) {
						set[key] = rawValue;
					} else {
						errors.push(`items[${i}].set.${key}: unzulässiger Werttyp`);
					}
				}
				actions.push({ type: 'frontmatter.patch', path, set, remove: [], ...(Object.keys(add).length > 0 ? { add } : {}) });
			}
			if (errors.length > 0) return { ok: false, errors };
			return { ok: true, actions };
		},
	};
}

const SECTION_CONTRACT_TAIL = 'als Markdown-Text — kein JSON, keine Code-Fence, keine Erklärungen davor oder danach.';
const NEUTRAL_EXAMPLE = '## Zusammenfassung\n- Kernaussage eins\n- Kernaussage zwei';

/** Der Text, den ein Modell als reinen Markdown-Text liefert (Denkblöcke und Zaun entfernt der Output-Validator vorher): nicht leer,
 *  höchstens `maxChars`. Gibt die Fehler zurück; `text` ist dann nicht zu verwenden. */
function checkMarkdown(text: unknown, maxChars: number, target: string | null, action: string): string[] {
	const errors: string[] = [];
	if (typeof text !== 'string' || text.trim().length === 0) {
		errors.push('markdown: leer oder kein Text');
	} else if (text.length > maxChars) {
		errors.push(`markdown: ${text.length} Zeichen überschreiten Maximum ${maxChars}`);
	}
	if (target === null) errors.push(`target: actions-Task ohne target kann ${action} nicht anwenden`);
	return errors;
}

/** `wording: 'briefing'` ist der Wortlaut von `briefing-v1`; der daily-briefing-Golden-Test prüft ihn byte-genau über den promptHash
 *  (promptContract + outputExample). `neutral` gilt für jede Crew, die `section.write` über `output:` wählt. */
export function makeSectionWrite(maxChars: number, wording: 'briefing' | 'neutral'): SchemaDef {
	return {
		id: 'section.write',
		outputFormat: 'text',
		promptContract: wording === 'briefing'
			? `Antworte ausschließlich mit dem fertigen Briefing ${SECTION_CONTRACT_TAIL}`
			: `Antworte ausschließlich mit dem fertigen Abschnitt ${SECTION_CONTRACT_TAIL}`,
		outputExample: wording === 'briefing'
			? '## Heute fällig\n- Beispiel-Aufgabe\n\n## Überfällig\n- …\n\n## Eine nächste Handlung\n- …'
			: NEUTRAL_EXAMPLE,
		validate(json, _sources, _slugTables, target) {
			const text = json;
			const errors = checkMarkdown(text, maxChars, target, 'section.write');
			if (errors.length > 0 || typeof text !== 'string' || target === null) return { ok: false, errors };
			return { ok: true, actions: [{ type: 'section.replace', path: target, content: text.trim() }] };
		},
	};
}

/** Hängt den Text des Modells an die Zielnotiz an (`note.append`), unter `heading`, wenn gesetzt. */
export function makeTextAppend(maxChars: number, heading: string | null): SchemaDef {
	return {
		id: 'text.append',
		outputFormat: 'text',
		promptContract: `Antworte ausschließlich mit dem Text, der angehängt wird, ${SECTION_CONTRACT_TAIL}`,
		outputExample: NEUTRAL_EXAMPLE,
		validate(json, _sources, _slugTables, target) {
			const text = json;
			const errors = checkMarkdown(text, maxChars, target, 'text.append');
			if (errors.length > 0 || typeof text !== 'string' || target === null) return { ok: false, errors };
			return { ok: true, actions: [{ type: 'note.append', path: target, heading, content: text.trim() }] };
		},
	};
}

/** Was ein Schema zur Laufzeit wissen muss und das Crew-Datei nicht festlegt: der Zeitpunkt des Aufrufs (für `{{today}}`), die Notiz, die
 *  ein `per_note`-Aufruf gerade bearbeitet (`null` ohne `per_note`), und die Zielordner, die der Orchestrator für `note.file` aufgelöst hat. */
export interface SchemaRuntime { nowMs: number; notePath: string | null; destinations: Destination[] }

export const TITLE_MAX_CHARS = 120;

/** Warum ein Titel kein Dateiname einer neuen Notiz sein kann, sonst `null`. `title` ist schon getrimmt. Gezählt wird in Codepunkten.
 *  Ein Titel braucht mindestens einen Buchstaben oder eine Ziffer: die Namensrichtlinie macht aus einem Titel ohne beides sonst
 *  `Untitled` (`...`) oder lässt ihn als bloßes Emoji stehen, beides keine Notiz, die jemand finden will. */
function titleProblem(title: string): string | null {
	const length = [...title].length;
	if (length === 0) return 'ist leer';
	if (length > TITLE_MAX_CHARS) return `${length} Zeichen überschreiten Maximum ${TITLE_MAX_CHARS}`;
	if (/[/\\]/.test(title)) return 'enthält / oder \\ (der Titel ist ein Dateiname, kein Pfad)';
	if ([...title].some((c) => { const cp = c.codePointAt(0) ?? 0; return cp < 0x20 || cp === 0x7f; })) return 'enthält Steuerzeichen oder Zeilenumbrüche';
	if (!/[\p{L}\p{N}]/u.test(title)) return 'braucht mindestens einen Buchstaben oder eine Ziffer';
	return null;
}

/** Neue Notizen: Ordner und Frontmatter stehen in der Crew-Datei, das Modell liefert nur `title` und `body` je Eintrag. Der Pfad ist
 *  `<Ordner>/<Titel>.md`; die Quell-Notiz des Aufrufs steht als Wikilink im Feld `linkSource` (Pfadlink, eindeutig auch bei gleichnamigen
 *  Notizen). Dass ein Titel schon belegt ist, entscheidet der Executor (`code: 'exists'`), nicht das Schema. */
export function makeNotesCreate(spec: Extract<OutputSpec, { family: 'notes.create' }>, rt: SchemaRuntime): SchemaDef {
	const folder = expandTarget(spec.folder, rt.nowMs);
	const fixed = { ...spec.frontmatter };
	const order = Object.keys(fixed);
	if (spec.linkSource !== null && rt.notePath !== null) {
		// Lässt sich der Pfad nicht als Link schreiben (`#`, `|`, …), steht er als Text: ein sichtbarer Pfad ist besser als ein falscher Link.
		fixed[spec.linkSource] = wikilinkOf(rt.notePath) ?? rt.notePath;
		order.push(spec.linkSource);
	}
	const head = serializeFrontmatter(fixed, order);
	return {
		id: 'notes.create',
		outputFormat: 'json',
		promptContract:
			'Antworte ausschließlich mit einem JSON-Objekt in einem ```json-Block, keine Erklärungen davor oder danach. '
			+ `Jeder Eintrag in items wird eine neue Notiz: title ist ihr Name (ein Dateiname, kein Pfad, höchstens ${TITLE_MAX_CHARS} Zeichen), `
			+ `body ihr Text. Höchstens ${spec.maxItems} Einträge; nichts zu tun heißt eine leere Liste.`,
		outputExample: '{"items": [{"title": "Angebot an Meyer schicken", "body": "Bis Freitag, Vorlage vom letzten Mal."}]}',
		validate(json, _sources, _slugTables, _target) {
			if (!isRecord(json) || !Array.isArray(json.items)) return { ok: false, errors: ['items: fehlt oder ist keine Liste'] };
			const items: unknown[] = json.items;
			const errors: string[] = [];
			if (items.length > spec.maxItems) errors.push(`items: ${items.length} überschreitet max_items ${spec.maxItems}`);
			const actions: NoteCreateAction[] = [];
			for (let i = 0; i < items.length; i++) {
				const item: unknown = items[i];
				if (!isRecord(item)) { errors.push(`items[${i}]: ist kein Objekt`); continue; }
				if (typeof item.title !== 'string') { errors.push(`items[${i}].title: fehlt oder ist kein Text`); continue; }
				const title = item.title.trim();
				const problem = titleProblem(title);
				if (problem !== null) { errors.push(`items[${i}].title: ${problem}`); continue; }
				if (typeof item.body !== 'string') { errors.push(`items[${i}].body: fehlt oder ist kein Text`); continue; }
				const body = item.body.trim();
				actions.push({ type: 'note.create', path: `${folder}/${title}.md`, content: body === '' ? head : `${head}\n${body}\n` });
			}
			if (errors.length > 0) return { ok: false, errors };
			return { ok: true, actions };
		},
	};
}

/** Das Ziel, das ein Modell für „nicht ablegen“ nennt; als Ordnername ist es reserviert (der Parser lehnt ihn ab, die Laufzeitliste lässt ihn weg). */
export const NO_DESTINATION = 'none';
const MAX_FILE_ITEMS = 50;

/** Ablegen: das Modell wählt je Notiz einen Zielordner aus der fertigen Liste (feste Ziele zuerst, dann Laufzeitziele) oder `none`. Das Schema baut daraus
 *  `note.move` mit unverändertem Dateinamen. `none` und der eigene Ordner der Notiz erzeugen keine Aktion. Ein Ziel, das nicht in der Liste steht, ist eine
 *  ungültige Antwort (Reparatur-Runde); die Notiz muss im Quellmaterial stehen (Quellbindung). Ob das Ziel existiert, frei ist und im `write_scope` liegt,
 *  prüft der Executor. */
export function makeNoteFile(destinations: Destination[]): SchemaDef {
	const known = new Set(destinations.map((d) => d.folder));
	const lines = destinations.map((d) => (d.when === null ? `- ${d.folder}` : `- ${d.folder}: ${d.when}`));
	return {
		id: 'note.file',
		outputFormat: 'json',
		promptContract:
			'Antworte ausschließlich mit einem JSON-Objekt in einem ```json-Block, keine Erklärungen davor oder danach. '
			+ 'Jeder Eintrag in items ordnet eine Notiz einem Ordner zu: path ist der Pfad der Notiz aus dem Material, '
			+ `to genau einer der folgenden Ordner, oder ${NO_DESTINATION}, wenn die Notiz bleiben soll. Erlaubte Ordner:\n${lines.join('\n')}`,
		outputExample: `{"items": [{"path": "Inbox/beispiel.md", "to": "${destinations[0]?.folder ?? 'Projekte/Beispiel'}"}, {"path": "Inbox/offen.md", "to": "${NO_DESTINATION}"}]}`,
		validate(json, sources, _slugTables, _target) {
			if (!isRecord(json) || !Array.isArray(json.items)) return { ok: false, errors: ['items: fehlt oder ist keine Liste'] };
			const items: unknown[] = json.items;
			const errors: string[] = [];
			if (items.length > MAX_FILE_ITEMS) errors.push(`items: ${items.length} überschreitet Maximum ${MAX_FILE_ITEMS}`);
			const knownPaths = new Set(sources.map((s) => s.path));
			const chosen = new Map<string, string | null>();   // Pfad → Zielpfad (null: bleibt), für Wiederholungen derselben Notiz
			const actions: NoteMoveAction[] = [];
			for (let i = 0; i < items.length; i++) {
				const item: unknown = items[i];
				if (!isRecord(item)) { errors.push(`items[${i}]: ist kein Objekt`); continue; }
				if (typeof item.path !== 'string') { errors.push(`items[${i}].path: fehlt oder ist kein Text`); continue; }
				if (!knownPaths.has(item.path)) {
					errors.push(`items[${i}].path: '${item.path}' kommt im Quellmaterial nicht vor (Quellbindung)`);
					continue;
				}
				if (typeof item.to !== 'string') { errors.push(`items[${i}].to: fehlt oder ist kein Text`); continue; }
				const to = item.to;
				if (to !== NO_DESTINATION && !known.has(to)) {
					errors.push(`items[${i}].to: '${to}' steht nicht in der Liste der Ordner (erlaubt: ${[...known, NO_DESTINATION].join(', ')})`);
					continue;
				}
				const slash = item.path.lastIndexOf('/');
				// `none` und der eigene Ordner der Notiz heißen beide „bleibt“: kein Widerspruch, keine Aktion.
				const goal = to === NO_DESTINATION || item.path.slice(0, slash < 0 ? 0 : slash) === to ? null : `${to}/${item.path.slice(slash + 1)}`;
				if (chosen.has(item.path)) {
					if (chosen.get(item.path) !== goal) errors.push(`items[${i}].path: '${item.path}' hat zwei verschiedene Ziele`);
					continue;
				}
				chosen.set(item.path, goal);
				if (goal !== null) actions.push({ type: 'note.move', path: item.path, to: goal });
			}
			if (errors.length > 0) return { ok: false, errors };
			return { ok: true, actions };
		},
	};
}

export function buildSchema(spec: OutputSpec, rt?: SchemaRuntime): SchemaDef {
	switch (spec.family) {
		case 'frontmatter.set':
			return makeFrontmatterSet(spec.allowedKeys, spec.addTo);
		case 'section.write':
			return makeSectionWrite(spec.maxChars, spec.wording);
		case 'text.append':
			return makeTextAppend(spec.maxChars, spec.heading);
		case 'notes.create':
			if (rt === undefined) throw new Error('notes.create braucht eine SchemaRuntime (Zeitpunkt, Notiz)');
			return makeNotesCreate(spec, rt);
		case 'note.file':
			if (rt === undefined) throw new Error('note.file braucht eine SchemaRuntime (die Liste der Zielordner)');
			return makeNoteFile(rt.destinations);
	}
}

export const BUILTIN_SCHEMAS: Record<SchemaId, SchemaDef> = {
	'triage-v1': makeFrontmatterSet('*'),
	'briefing-v1': makeSectionWrite(16_000, 'briefing'),
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
