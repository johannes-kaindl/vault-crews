/** Eingebaute, versionierte Output-Schemata (Spec §3.4): bewusst KEINE user-definierbare
 *  Schema-DSL in V1 und kein Ajv (eval-Compile). Jedes Schema validiert das LLM-JSON UND
 *  erzeugt daraus die deterministische Aktionsliste — ein einziger Übergabepunkt.
 *  Quellbindung macht Pfad-Halluzination strukturell unmöglich; Slug-Rück-Mapping passiert
 *  HIER (der Executor kennt keine SlugTables, Skelett-ExecutorContext). */
import type { Action, CollectedFile, FrontmatterPatchAction, SchemaId, SlugTableData } from './types';

export interface SchemaDef {
	id: SchemaId;
	/** One-Shot-Minimalbeispiel für den Prompt — bei kleinen Modellen wirksamer als Schema-Prosa. */
	jsonExample: string;
	validate(
		json: unknown,
		sources: CollectedFile[],
		slugTables: Record<string, SlugTableData>,
		target: string | null,
	): { ok: true; actions: Action[] } | { ok: false; errors: string[] };
}

const MAX_TRIAGE_ITEMS = 50;
const MAX_BRIEFING_CHARS = 16_000;

const triageV1: SchemaDef = {
	id: 'triage-v1',
	jsonExample: '{"items": [{"path": "10_Aufgaben/beispiel.md", "set": {"priority": "mittel"}}]}',
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
			const set: Record<string, string | number | null> = {};
			for (const [key, rawValue] of Object.entries(item.set)) {
				const table = slugTables[key];
				if (table) {
					if (typeof rawValue !== 'string' || !(rawValue in table.fromSlug)) {
						errors.push(`items[${i}].set.${key}: '${String(rawValue)}' ist kein erlaubter Wert (${Object.keys(table.fromSlug).sort().join(', ')})`);
						continue;
					}
					set[key] = table.fromSlug[rawValue] ?? rawValue;
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

const briefingV1: SchemaDef = {
	id: 'briefing-v1',
	jsonExample: '{"markdown": "## Heute fällig\\n- Beispiel-Aufgabe"}',
	validate(json, _sources, _slugTables, target) {
		const errors: string[] = [];
		if (target === null) errors.push('target: actions-Task ohne target kann briefing-v1 nicht anwenden');
		if (!isRecord(json) || typeof json.markdown !== 'string') {
			errors.push('markdown: fehlt oder ist kein String');
		} else if (json.markdown.length > MAX_BRIEFING_CHARS) {
			errors.push(`markdown: ${json.markdown.length} Zeichen überschreiten Maximum ${MAX_BRIEFING_CHARS}`);
		}
		if (errors.length > 0 || !isRecord(json) || target === null) return { ok: false, errors };
		return { ok: true, actions: [{ type: 'section.replace', path: target, content: json.markdown as string }] };
	},
};

export const BUILTIN_SCHEMAS: Record<SchemaId, SchemaDef> = {
	'triage-v1': triageV1,
	'briefing-v1': briefingV1,
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
