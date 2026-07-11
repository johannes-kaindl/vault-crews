# Parametrisierbare Output-Schema-Familien — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das Crew-Output-Vokabular öffnen — `triage-v1`/`briefing-v1` werden Spezialfälle zweier parametrisierbarer Schema-Familien (`frontmatter.set`, `section.write`), inline am `llm`-Task konfigurierbar, ohne den Sicherheitskern (Source-Binding, Slug-Enums) aufzuweichen.

**Architecture:** Ein Schema wird von einem fest instanziierten Objekt zu einer Factory `(params) → SchemaDef`. Der Parser löst sowohl die neue `output:`-Syntax als auch die alten `output_schema:`-Aliase auf ein internes `OutputSpec` auf; der Orchestrator baut daraus per `buildSchema(spec)` das `SchemaDef`. `output-validator.ts` bleibt unverändert — es nimmt ein `SchemaDef` und weiß nicht, woher es kommt.

**Tech Stack:** TypeScript, Vitest (node-env, Obsidian-Mock via `resolve.alias`), esbuild. Pure-Layer (`src/core/**`) importiert nie `obsidian` (CI-Gate `check:pure`).

## Global Constraints

- **Gate vor jedem Commit grün:** `npm run gate` = lint + typecheck + test + check:pure. Exit-Code prüfen, nicht grep-Ausgabe.
- **`src/core/**` importiert NIE `obsidian`** — `schemas.ts`, `types.ts`, `crew-parser.ts`, `output-validator.ts`, `orchestrator.ts` bleiben pure.
- **TDD:** erst fehlschlagender Test, dann minimale Implementierung.
- **Commit-Stil:** Conventional Commits + Trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Sicherheitskern unantastbar:** `SchemaDef.validate` bleibt der einzige Punkt, der `Action[]` erzeugt; Source-Binding (`knownPaths.has(path)`) und Slug-Enums (`slugTables[key]`) bleiben wortgleich erhalten.
- **Familien-Parameter sind rein deklarativ** (Wertelisten/Zahlen) — keine DSL, kein `eval`, kein Ajv.

---

### Task 1: Schema-Factories + `buildSchema` + `OutputSpec`-Typ

Kern der Änderung, komplett isoliert testbar über `SchemaDef.validate`. Additiv: `BUILTIN_SCHEMAS` bleibt vorerst exportiert (Orchestrator nutzt es bis Task 2), wird aber DRY über die Factories gebaut.

**Files:**
- Modify: `src/core/types.ts` (nach Zeile 16 `ActionType`-Definition: `OutputSpec` hinzufügen)
- Modify: `src/core/schemas.ts` (Objekte `triageV1`/`briefingV1` → Factories; `buildSchema`; `SchemaDef.id: SchemaId` → `id: string`; `BUILTIN_SCHEMAS` über Factories)
- Test: `tests/core/schemas.test.ts` (neu)

**Interfaces:**
- Produces:
  - `type OutputSpec = { family: 'frontmatter.set'; allowedKeys: string[] | '*' } | { family: 'section.write'; maxChars: number }` (in `types.ts`)
  - `function buildSchema(spec: OutputSpec): SchemaDef` (in `schemas.ts`)
  - `function makeFrontmatterSet(allowedKeys: string[] | '*'): SchemaDef`
  - `function makeSectionWrite(maxChars: number): SchemaDef`
  - `BUILTIN_SCHEMAS` bleibt `Record<SchemaId, SchemaDef>` (unveränderte Signatur)

- [ ] **Step 1: Add the `OutputSpec` type**

In `src/core/types.ts`, direkt nach der Zeile `export type ActionType = …` (Zeile 16) einfügen:

```typescript
export type OutputSpec =
	| { family: 'frontmatter.set'; allowedKeys: string[] | '*' }
	| { family: 'section.write'; maxChars: number };
```

- [ ] **Step 2: Write the failing test for the factories**

Create `tests/core/schemas.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildSchema, makeFrontmatterSet, makeSectionWrite } from '../../src/core/schemas';
import type { CollectedFile, SlugTableData } from '../../src/core/types';

const sources: CollectedFile[] = [
	{ path: '10_Aufgaben/a.md', contentHash: 'h', frontmatter: null, content: null },
];
const noSlugs: Record<string, SlugTableData> = {};

describe('makeFrontmatterSet', () => {
	it('accepts a key listed in allowedKeys', () => {
		const schema = makeFrontmatterSet(['tags']);
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { tags: 'x' } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.actions).toEqual([{ type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { tags: 'x' }, remove: [] }]);
	});

	it('rejects a key NOT in allowedKeys', () => {
		const schema = makeFrontmatterSet(['tags']);
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { prioritaet: 'hoch' } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/prioritaet.*allowed_keys/);
	});

	it("wildcard '*' allows any key (triage-v1 legacy behaviour)", () => {
		const schema = makeFrontmatterSet('*');
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { beliebig: 1 } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(true);
	});

	it('still enforces source-binding regardless of allowedKeys', () => {
		const schema = makeFrontmatterSet('*');
		const r = schema.validate({ items: [{ path: 'fremd/x.md', set: { tags: 'x' } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/Quellbindung/);
	});
});

describe('makeSectionWrite', () => {
	it('produces one section.replace into target', () => {
		const schema = makeSectionWrite(16000);
		const r = schema.validate('# Hallo', sources, noSlugs, '30_Chronos/heute.md');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.actions).toEqual([{ type: 'section.replace', path: '30_Chronos/heute.md', content: '# Hallo' }]);
	});

	it('rejects text over maxChars', () => {
		const schema = makeSectionWrite(5);
		const r = schema.validate('123456', sources, noSlugs, '30_Chronos/heute.md');
		expect(r.ok).toBe(false);
	});
});

describe('buildSchema', () => {
	it('dispatches frontmatter.set', () => {
		expect(buildSchema({ family: 'frontmatter.set', allowedKeys: ['tags'] }).outputFormat).toBe('json');
	});
	it('dispatches section.write', () => {
		expect(buildSchema({ family: 'section.write', maxChars: 16000 }).outputFormat).toBe('text');
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/core/schemas.test.ts`
Expected: FAIL — `makeFrontmatterSet`/`makeSectionWrite`/`buildSchema` sind nicht exportiert.

- [ ] **Step 4: Refactor `schemas.ts` into factories**

Replace the body of `src/core/schemas.ts` from the `SchemaDef` interface's `id` field through the end of file. First change the interface field:

```typescript
export interface SchemaDef {
	/** Familien-/Alias-Kennung für Logging (extern nicht als Enum gelesen). */
	id: string;
```

Then replace the `triageV1`/`briefingV1` constants and `BUILTIN_SCHEMAS`/`isRecord` tail (Zeile 27 bis Dateiende) with:

```typescript
const MAX_TRIAGE_ITEMS = 50;

export function makeFrontmatterSet(allowedKeys: string[] | '*'): SchemaDef {
	return {
		id: 'frontmatter.set',
		outputFormat: 'json',
		promptContract:
			'Antworte ausschließlich mit einem JSON-Objekt in einem ```json-Block, keine Erklärungen davor oder danach.',
		outputExample: '{"items": [{"path": "10_Aufgaben/beispiel.md", "set": {"priority": "mittel"}}]}',
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
					if (allowedKeys !== '*' && !allowedKeys.includes(key)) {
						errors.push(`items[${i}].set.${key}: Feld nicht in allowed_keys (${allowedKeys.join(', ')})`);
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

export function makeSectionWrite(maxChars: number): SchemaDef {
	return {
		id: 'section.write',
		outputFormat: 'text',
		promptContract:
			'Antworte ausschließlich mit dem fertigen Text als Markdown — kein JSON, keine Code-Fence, keine Erklärungen davor oder danach.',
		outputExample: '## Heute fällig\n- Beispiel-Aufgabe\n\n## Überfällig\n- …\n\n## Eine nächste Handlung\n- …',
		validate(json, _sources, _slugTables, target) {
			const errors: string[] = [];
			const text = json;
			if (typeof text !== 'string' || text.trim().length === 0) {
				errors.push('markdown: leer oder kein Text');
			} else if (text.length > maxChars) {
				errors.push(`markdown: ${text.length} Zeichen überschreiten Maximum ${maxChars}`);
			}
			if (target === null) errors.push('target: actions-Task ohne target kann section.write nicht anwenden');
			if (errors.length > 0 || typeof text !== 'string' || target === null) return { ok: false, errors };
			return { ok: true, actions: [{ type: 'section.replace', path: target, content: text.trim() }] };
		},
	};
}

export function buildSchema(spec: OutputSpec): SchemaDef {
	switch (spec.family) {
		case 'frontmatter.set':
			return makeFrontmatterSet(spec.allowedKeys);
		case 'section.write':
			return makeSectionWrite(spec.maxChars);
	}
}

export const BUILTIN_SCHEMAS: Record<SchemaId, SchemaDef> = {
	'triage-v1': makeFrontmatterSet('*'),
	'briefing-v1': makeSectionWrite(16_000),
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
```

Update the import line at the top of `schemas.ts` to add `OutputSpec` and drop the now-unused `SchemaId` only if unused (it is still used by `BUILTIN_SCHEMAS`, so keep it):

```typescript
import type { Action, CollectedFile, FrontmatterPatchAction, OutputSpec, SchemaId, SlugTableData } from './types';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/core/schemas.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Run the full gate to verify nothing broke**

Run: `npm run gate`
Expected: PASS. `BUILTIN_SCHEMAS` unverändert konsumierbar durch `orchestrator.ts` und `output-validator.test.ts`; `daily-briefing`-Golden weiter grün (Verhalten von `makeSectionWrite(16000)` == altes `briefingV1`).

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/schemas.ts tests/core/schemas.test.ts
git commit -m "feat(schemas): Schema-Familien-Factories + buildSchema

triageV1/briefingV1 werden makeFrontmatterSet('*')/makeSectionWrite(16000).
Neues allowed_keys-Gate in frontmatter.set (verengt gegenüber triage-v1).
BUILTIN_SCHEMAS DRY über die Factories gebaut, Signatur unverändert.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Cutover `LlmTaskDef.output` (verhaltensneutral)

`LlmTaskDef.outputSchema: SchemaId` → `output: OutputSpec`. Der Parser löst `output_schema:` weiterhin, jetzt über eine Alias-Funktion auf ein `OutputSpec`; der Orchestrator baut das Schema per `buildSchema`. Keine neue Syntax, keine Verhaltensänderung — die bestehenden Beispiel-Crews und Tests bleiben grün (Rückwärtskompat-Beweis).

**Files:**
- Modify: `src/core/types.ts:24-32` (`LlmTaskDef`)
- Modify: `src/core/crew-parser.ts:108-119` (llm-Case) — Alias-Auflösung
- Modify: `src/core/orchestrator.ts:245` — `buildSchema(task.output)`; Import anpassen
- Modify: `tests/core/crew-parser.test.ts` — Assertions `outputSchema` → `output`

**Interfaces:**
- Consumes: `OutputSpec`, `buildSchema` (Task 1)
- Produces:
  - `LlmTaskDef` mit `output: OutputSpec` (statt `outputSchema: SchemaId`)
  - `function resolveSchemaAlias(id: string): OutputSpec | null` (in `crew-parser.ts`, wird in Task 3 wiederverwendet)

- [ ] **Step 1: Change the `LlmTaskDef` type**

In `src/core/types.ts`, replace `outputSchema: SchemaId;` (Zeile 30) with:

```typescript
	output: OutputSpec;
```

Add `OutputSpec` to consumers as needed (types.ts defines it, so no import). Note: `SchemaId` in types.ts stays (used by `schemas.ts`).

- [ ] **Step 2: Update the failing parser test expectations**

In `tests/core/crew-parser.test.ts`, find the assertion(s) that read `.outputSchema` on a parsed llm task and change them to the new shape. Example (adapt to the actual test's variable names):

```typescript
// vorher: expect(llmTask.outputSchema).toBe('triage-v1');
expect(llmTask.output).toEqual({ family: 'frontmatter.set', allowedKeys: '*' });
// briefing-v1:
expect(briefTask.output).toEqual({ family: 'section.write', maxChars: 16000 });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/core/crew-parser.test.ts`
Expected: FAIL — `output` is `undefined` / type error, parser still emits `outputSchema`.

- [ ] **Step 4: Add the alias resolver and rewire the llm-case in the parser**

In `src/core/crew-parser.ts`, add near the top (after the `isRecord` helper or above `parseTeamDef`):

```typescript
/** Löst die Legacy-`output_schema:`-IDs auf ein OutputSpec auf. Einzige Stelle,
 *  an der triage-v1/briefing-v1 zu Familien werden. */
function resolveSchemaAlias(id: string): OutputSpec | null {
	switch (id) {
		case 'triage-v1': return { family: 'frontmatter.set', allowedKeys: '*' };
		case 'briefing-v1': return { family: 'section.write', maxChars: 16_000 };
		default: return null;
	}
}
```

Add `OutputSpec` to the type import from `./types` (Zeile 5-7) and remove `SchemaId` if it becomes unused (it will — the parser no longer references the `SchemaId` union directly). Delete the `const SCHEMAS: SchemaId[] = …` line (Zeile 12).

Replace the llm-case output-schema block (Zeile 113-114 plus the `def` construction at 117) so the case reads:

```typescript
				case 'llm': {
					const agent = typeof raw.agent === 'string' ? raw.agent : '';
					if (!opts.knownAgents.includes(agent)) err(`${label}.agent`, `'${agent}' unbekannt (vorhanden: ${opts.knownAgents.join(', ') || '—'})`);
					const instruction = typeof raw.instruction === 'string' && raw.instruction.trim() !== '' ? raw.instruction.trim() : null;
					if (instruction === null) err(`${label}.instruction`, 'fehlt oder leer');
					const output = resolveSchemaAlias(typeof raw.output_schema === 'string' ? raw.output_schema : '');
					if (output === null) err(`${label}.output_schema`, `'${show(raw.output_schema)}' (erwartet triage-v1|briefing-v1)`);
					const onError = raw.on_error === 'skip' ? 'skip' : 'abort';
					if (raw.on_error !== undefined && raw.on_error !== 'skip' && raw.on_error !== 'abort') err(`${label}.on_error`, `'${show(raw.on_error)}' (erwartet abort|skip)`);
					const def: LlmTaskDef = { id, kind: 'llm', agent, inputs, instruction: instruction ?? '', output: output ?? { family: 'frontmatter.set', allowedKeys: '*' }, onError };
					tasks.push(def);
					break;
				}
```

- [ ] **Step 5: Rewire the orchestrator**

In `src/core/orchestrator.ts`, change the import (Zeile 10) and the schema lookup (Zeile 245):

```typescript
// Zeile 10:
import { buildSchema } from './schemas';
// Zeile 245:
		const schema = buildSchema(task.output);
```

Verify `BUILTIN_SCHEMAS` is no longer imported anywhere except `output-validator.test.ts`; leave the export in `schemas.ts` (still consumed by that test).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/core/crew-parser.test.ts tests/core/orchestrator.test.ts tests/golden/daily-briefing.test.ts`
Expected: PASS — parser emits `output`, orchestrator builds the schema, golden briefing byte-identical.

- [ ] **Step 7: Run the full gate**

Run: `npm run gate`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/core/crew-parser.ts src/core/orchestrator.ts tests/core/crew-parser.test.ts
git commit -m "refactor(crew): LlmTaskDef.output: OutputSpec (Alias-Cutover)

output_schema: wird beim Parsen über resolveSchemaAlias auf ein OutputSpec
aufgelöst; Orchestrator baut das Schema per buildSchema. Verhaltensneutral,
Beispiel-Crews byte-identisch.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Neue `output:`-Syntax + Fehlerklassen

Der Parser lernt den `output:`-Block. `output:` und `output_schema:` schließen sich aus. Neue Preflight-Fehler: unbekannte `family`, `allowed_keys` fehlt/leer bei `frontmatter.set`, artfremder Parameter, beide Felder gesetzt, keins gesetzt.

**Files:**
- Modify: `src/core/crew-parser.ts` (llm-case + neuer Helfer `parseOutputBlock`)
- Modify: `tests/core/crew-parser.test.ts` (neue Fälle)

**Interfaces:**
- Consumes: `OutputSpec`, `resolveSchemaAlias` (Task 2)
- Produces: `function parseOutputBlock(raw, label, err): OutputSpec | null` (intern in `crew-parser.ts`)

- [ ] **Step 1: Write the failing tests for the new syntax**

Add to `tests/core/crew-parser.test.ts` (adapt the `parseTeamDef` call + `opts` to the file's existing helper — most tests build a minimal team frontmatter and known agent list):

```typescript
describe('output: block (schema families)', () => {
	// helper `parseTeam(tasks)` steht für den in dieser Datei bereits genutzten Aufbau
	// eines minimalen Team-Frontmatters mit bekanntem Agent 'a'.

	it('parses frontmatter.set with allowed_keys', () => {
		const r = parseTeam([
			{ id: 'c', kind: 'collector', collector: 'vault.list', params: {} },
			{ id: 'l', kind: 'llm', agent: 'a', inputs: ['c'], instruction: 'x', output: { family: 'frontmatter.set', allowed_keys: ['tags', 'kategorie'] } },
		]);
		expect(r.ok).toBe(true);
		if (r.ok) expect((r.value.tasks[1] as { output: unknown }).output).toEqual({ family: 'frontmatter.set', allowedKeys: ['tags', 'kategorie'] });
	});

	it('parses section.write with default max_chars', () => {
		const r = parseTeam([
			{ id: 'l', kind: 'llm', agent: 'a', inputs: [], instruction: 'x', output: { family: 'section.write' } },
			{ id: 'ap', kind: 'actions', inputs: ['l'], allowed_actions: ['section.replace'], target: '30_Chronos/heute.md' },
		]);
		expect(r.ok).toBe(true);
		if (r.ok) expect((r.value.tasks[0] as { output: unknown }).output).toEqual({ family: 'section.write', maxChars: 16000 });
	});

	it('rejects unknown family', () => {
		const r = parseTeam([{ id: 'l', kind: 'llm', agent: 'a', inputs: [], instruction: 'x', output: { family: 'note.append' } }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/family.*frontmatter\.set\|section\.write/);
	});

	it('rejects frontmatter.set without allowed_keys', () => {
		const r = parseTeam([{ id: 'l', kind: 'llm', agent: 'a', inputs: [], instruction: 'x', output: { family: 'frontmatter.set' } }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/allowed_keys/);
	});

	it('rejects both output and output_schema on one task', () => {
		const r = parseTeam([{ id: 'l', kind: 'llm', agent: 'a', inputs: [], instruction: 'x', output_schema: 'triage-v1', output: { family: 'frontmatter.set', allowed_keys: ['tags'] } }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/output.*output_schema|nicht beide/);
	});

	it('rejects a task with neither output nor output_schema', () => {
		const r = parseTeam([{ id: 'l', kind: 'llm', agent: 'a', inputs: [], instruction: 'x' }]);
		expect(r.ok).toBe(false);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/crew-parser.test.ts -t "output: block"`
Expected: FAIL — parser ignoriert `output:`, akzeptiert beide Felder, etc.

- [ ] **Step 3: Add `parseOutputBlock` and branch the llm-case**

In `src/core/crew-parser.ts`, add the helper below `resolveSchemaAlias`:

```typescript
/** Parst den neuen `output:`-Block einer llm-Task auf ein OutputSpec. */
function parseOutputBlock(
	raw: unknown,
	feld: string,
	err: (feld: string, problem: string) => void,
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
		return { family: 'frontmatter.set', allowedKeys: keys };
	}
	if (family === 'section.write') {
		if (raw.allowed_keys !== undefined) err(`${feld}.allowed_keys`, 'gilt nur für frontmatter.set');
		const maxChars = typeof raw.max_chars === 'number' && raw.max_chars > 0 ? raw.max_chars : 16_000;
		return { family: 'section.write', maxChars };
	}
	err(`${feld}.family`, `'${show(family)}' (erwartet frontmatter.set|section.write)`);
	return null;
}
```

Replace the output-resolution line inside the llm-case (from Task 2) with the either/or logic:

```typescript
				const hasBlock = raw.output !== undefined;
				const hasLegacy = raw.output_schema !== undefined;
				let output: OutputSpec | null = null;
				if (hasBlock && hasLegacy) {
					err(`${label}.output`, 'nicht beide: output und output_schema gleichzeitig gesetzt');
				} else if (hasBlock) {
					output = parseOutputBlock(raw.output, `${label}.output`, err);
				} else if (hasLegacy) {
					output = resolveSchemaAlias(typeof raw.output_schema === 'string' ? raw.output_schema : '');
					if (output === null) err(`${label}.output_schema`, `'${show(raw.output_schema)}' (erwartet triage-v1|briefing-v1)`);
				} else {
					err(`${label}.output`, 'fehlt (erwartet output-Block oder output_schema)');
				}
				const def: LlmTaskDef = { id, kind: 'llm', agent, inputs, instruction: instruction ?? '', output: output ?? { family: 'frontmatter.set', allowedKeys: '*' }, onError };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/core/crew-parser.test.ts`
Expected: PASS — new cases green, legacy cases (Task 2) still green.

- [ ] **Step 5: Run the full gate**

Run: `npm run gate`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/crew-parser.ts tests/core/crew-parser.test.ts
git commit -m "feat(crew): output:-Block-Syntax für parametrisierte Schema-Familien

llm-Task akzeptiert output: {family, allowed_keys|max_chars}; schließt sich
mit output_schema: aus. Neue Preflight-Fehler: unbekannte family, fehlende
allowed_keys, artfremder Parameter, beide/keins gesetzt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Zwei Familien (`frontmatter.set`/`section.write`) → Task 1. ✓
- `allowed_keys`-Gate (strikter als triage-v1) → Task 1 Step 2/4. ✓
- Inline `output:`-Syntax → Task 3. ✓
- Rückwärtskompat via Alias (`'*'`-Wildcard) → Task 2 (`resolveSchemaAlias`) + Task 1 (`makeFrontmatterSet('*')`). ✓
- `output`/`output_schema` schließen sich aus → Task 3. ✓
- Neue Fehlerklassen → Task 3. ✓
- Betroffene Module (types/schemas/parser/orchestrator, output-validator unverändert) → Tasks 1-3; `output-validator.ts` bleibt unangetastet. ✓
- Sicherheits-Regression (Source-Binding trotz allowedKeys) → Task 1 Step 2. ✓
- Beispiel-Crews unverändert → keine Asset-Änderung in irgendeinem Task; Golden-Test in Task 2 Step 6. ✓
- Kein Release → kein Release-Task. ✓

**2. Placeholder scan:** Kein TBD/TODO; alle Code-Steps enthalten vollständigen Code. ✓

**3. Type consistency:** `OutputSpec` (Task 1) durchgängig; `buildSchema`/`makeFrontmatterSet`/`makeSectionWrite` (Task 1) in Task 2/3 unter gleichen Namen; `resolveSchemaAlias` (Task 2) in Task 3 wiederverwendet; `LlmTaskDef.output` (Task 2) in Task 3 gesetzt. `allowedKeys` (intern, camelCase) vs. `allowed_keys` (YAML/Frontmatter, snake_case) bewusst getrennt — Parser mappt snake→camel. ✓

**Offener Hinweis für den Executor:** `parseTeam(...)`-Helfer in den Task-3-Tests bezeichnet den in `crew-parser.test.ts` bereits vorhandenen Aufbau eines minimalen Team-Frontmatters; die exakte Signatur aus der Bestandsdatei übernehmen (nicht neu erfinden).
