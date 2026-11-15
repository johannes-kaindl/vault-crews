/** Eingebaute, versionierte Output-Schemata (Spec §3.4): bewusst KEINE user-definierbare
 *  Schema-DSL in V1 und kein Ajv (eval-Compile). Jedes Schema validiert das LLM-JSON UND
 *  erzeugt daraus die deterministische Aktionsliste — ein einziger Übergabepunkt.
 *  Quellbindung macht Pfad-Halluzination strukturell unmöglich; Slug-Rück-Mapping passiert
 *  HIER (der Executor kennt keine SlugTables, Skelett-ExecutorContext). */
import type { Action, CollectedFile, FmValue, FrontmatterPatchAction, OutputSpec, SchemaId, SlugTableData } from './types';

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

export function makeFrontmatterSet(allowedKeys: string[] | '*'): SchemaDef {
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
				for (const [key, rawValue] of Object.entries(item.set)) {
					if (allowedKeys !== '*' && !allowedKeys.includes(key)) {
						errors.push(`items[${i}].set.${key}: Feld nicht in allowed_keys (${allowedKeys.join(', ')})`);
						continue;
					}
					if (Array.isArray(rawValue)) {
						const table = slugTables[key];
						const list: (string | number)[] = [];
						let bad = false;
						for (const el of rawValue) {
							if (table) {
								if (typeof el !== 'string' || !(el in table.fromSlug)) {
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
						if (!bad) set[key] = list;
						continue;
					}
					const table = slugTables[key];
					if (table) {
						if (typeof rawValue !== 'string' || !(rawValue in table.fromSlug)) {
							errors.push(`items[${i}].set.${key}: '${String(rawValue)}' ist kein erlaubter Wert (${Object.keys(table.fromSlug).sort().join(', ')})`);
							continue;
						}
						set[key] = rawValue;
						continue;
					}
					if (typeof rawValue === 'string' || typeof rawValue === 'number' || rawValue === null) {
						set[key] = rawValue;
					} else {
						errors.push(`items[${i}].set.${key}: unzulässiger Werttyp`);
					}
				}
				actions.push({ type: 'frontmatter.patch', path, set, remove: [] });
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

export function buildSchema(spec: OutputSpec): SchemaDef {
	switch (spec.family) {
		case 'frontmatter.set':
			return makeFrontmatterSet(spec.allowedKeys);
		case 'section.write':
			return makeSectionWrite(spec.maxChars, spec.wording);
		case 'text.append':
			return makeTextAppend(spec.maxChars, spec.heading);
	}
}

export const BUILTIN_SCHEMAS: Record<SchemaId, SchemaDef> = {
	'triage-v1': makeFrontmatterSet('*'),
	'briefing-v1': makeSectionWrite(16_000, 'briefing'),
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
