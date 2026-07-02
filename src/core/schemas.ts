/** Eingebaute, versionierte Output-Schemata (Spec §3.4): bewusst KEINE user-definierbare
 *  Schema-DSL in V1 und kein Ajv (eval-Compile). Jedes Schema validiert das LLM-JSON UND
 *  erzeugt daraus die deterministische Aktionsliste — ein einziger Übergabepunkt.
 *  BUILTIN_SCHEMAS folgt in Plan Task 8. */
import type { Action, CollectedFile, SchemaId, SlugTableData } from './types';

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
