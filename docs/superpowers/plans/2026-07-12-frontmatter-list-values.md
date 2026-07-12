# Listen-Werte in `frontmatter.set` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `frontmatter.set` / `frontmatter.patch` unterstützen Listen-Werte (`tags: [a,b]`), damit der Notiz-Tagger tags als Liste schreiben kann — rückwärtskompatibel für Skalare.

**Architecture:** Ein geteilter `FmValue`-Typ (Skalar oder Liste-von-Skalaren) ersetzt `string|number|null` durch alle Schichten (Typ → validate → executor → port). Validierung und Slug-Rückmapping laufen bei Arrays elementweise. Der YAML-Write (`processFrontMatter`) kann Listen bereits — nur die Typ-Signatur wird gehoben.

**Tech Stack:** TypeScript, Vitest (node-env), esbuild. `src/core/**` importiert nie `obsidian`.

## Global Constraints

- **Gate vor jedem Commit grün:** `npm run gate` = lint + typecheck + test + check:pure. Exit-Code prüfen.
- **`src/core/**` importiert NIE `obsidian`** — types/schemas/action-executor/ports bleiben pure.
- **TDD:** erst fehlschlagender Test.
- **Rückwärtskompatibel:** Skalar-Verhalten bleibt byte-gleich (triage-v1/task-triage/bestehende Läufe unverändert).
- **Sicherheitskern pro Element:** Source-Binding (am Pfad) unverändert; Slug-Enum je Listenwert; `maxNoteBytes` je String-Element.
- **Listen enthalten nur `string`/`number`** — kein `null`, keine Objekte, keine Verschachtelung.
- **Byte-Identität:** geänderte Beispiel-Crew doppelt (TS-Konstante + `assets/examples/**`), byte-identisch.
- **Commit-Trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: `FmValue`-Typ + Array-Validierung + Executor (Kern-Cutover)

Der Typ zieht durch mehrere Dateien, die zusammen typechecken müssen — ein Task.

**Files:**
- Modify: `src/core/types.ts` (FmScalar/FmValue; `FrontmatterPatchAction.set`)
- Modify: `src/core/schemas.ts` (`makeFrontmatterSet.validate` Array-Zweig; `set`-Typ)
- Modify: `src/core/action-executor.ts` (`mappedSet`-Typ; elementweises Rückmapping/Byte-Check)
- Modify: `src/core/ports.ts` (`patchFrontmatter`-Signatur)
- Modify: `src/obsidian/vault-port.ts` (`patchFrontmatter`-Signatur, nur Typ)
- Test: `tests/core/schemas.test.ts`, `tests/core/action-executor.test.ts`

**Interfaces:**
- Produces: `type FmScalar = string | number | null`, `type FmValue = FmScalar | (string | number)[]` (in `types.ts`)
- `FrontmatterPatchAction.set: Record<string, FmValue>`

- [ ] **Step 1: Write the failing schema tests**

Add to `tests/core/schemas.test.ts` inside the `describe('makeFrontmatterSet', ...)` block:

```typescript
	it('accepts a string list value', () => {
		const schema = makeFrontmatterSet(['tags']);
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { tags: ['arbeit', 'notiz'] } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.actions).toEqual([{ type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { tags: ['arbeit', 'notiz'] }, remove: [] }]);
	});

	it('rejects a non-scalar list element (null)', () => {
		const schema = makeFrontmatterSet(['tags']);
		const r = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { tags: ['ok', null] } }] }, sources, noSlugs, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toMatch(/Listen-Element/);
	});

	it('enforces slug-enum per list element', () => {
		const slugs = { status: { toSlug: { '1_offen 📥': 'offen' }, fromSlug: { offen: '1_offen 📥' } } };
		const schema = makeFrontmatterSet(['status']);
		const ok = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { status: ['offen'] } }] }, sources, slugs, null);
		expect(ok.ok).toBe(true);
		const bad = schema.validate({ items: [{ path: '10_Aufgaben/a.md', set: { status: ['offen', 'quatsch'] } }] }, sources, slugs, null);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors.join('\n')).toMatch(/quatsch/);
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/schemas.test.ts -t "list"`
Expected: FAIL — array values are rejected as `unzulässiger Werttyp`.

- [ ] **Step 3: Add `FmScalar`/`FmValue` and update the action type**

In `src/core/types.ts`, add near the top (before `FrontmatterPatchAction`):

```typescript
export type FmScalar = string | number | null;
export type FmValue = FmScalar | (string | number)[];
```

Change `FrontmatterPatchAction.set` (currently `set: Record<string, string | number | null>;`) to:

```typescript
	set: Record<string, FmValue>;
```

- [ ] **Step 4: Add the array branch in `makeFrontmatterSet.validate`**

In `src/core/schemas.ts`, import `FmValue` from `./types`. Change the local `set` declaration inside `validate` (`const set: Record<string, string | number | null> = {};`) to:

```typescript
				const set: Record<string, FmValue> = {};
```

Insert the array branch as the **first** check inside the `for (const [key, rawValue] of Object.entries(item.set))` loop, immediately AFTER the `allowed_keys`-gate `continue` and BEFORE `const table = slugTables[key];`:

```typescript
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
```

(The existing scalar table/primitive branches below stay unchanged.)

- [ ] **Step 5: Run schema tests to verify they pass**

Run: `npx vitest run tests/core/schemas.test.ts`
Expected: PASS — list cases green, existing scalar cases unchanged.

- [ ] **Step 6: Write the failing executor test**

In `tests/core/action-executor.test.ts`, add a test using the file's existing setup pattern (its `ctx`/task/slugTables helpers — reuse them; do not invent new ones). The test: a `frontmatter.patch` action whose `set` has an array value on a slug-enum key is mapped back element-wise. Concretely assert that after execution the applied frontmatter for that key is the array of ORIGINAL (un-slugged) values. Mirror the shape of the existing scalar slug-mapping test in that file; the new assertion is that a `set: { <enumKey>: [<slug1>, <slug2>] }` results in the mapped originals `[<orig1>, <orig2>]`.

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/core/action-executor.test.ts -t <your-test-name>`
Expected: FAIL — array not mapped (type error or wrong output).

- [ ] **Step 8: Update the executor + port types for arrays**

In `src/core/action-executor.ts`, change the `mappedSet` type on the `ValidatedAction` interface (line ~38, currently `Record<string, string | number | null> | null`) to:

```typescript
	mappedSet: Record<string, import('./types').FmValue> | null;
```

Change the local `const mapped: Record<string, string | number | null> = {};` (in the `frontmatter.patch` branch) to `Record<string, FmValue>` (add `FmValue` to the existing `./types` import instead of the inline import if the file already imports from `./types`). Replace the `for (const [key, value] of Object.entries(action.set))` body so an array value is handled element-wise before the scalar path:

```typescript
			for (const [key, value] of Object.entries(action.set)) {
				if (Array.isArray(value)) {
					const table = ctx.slugTables[key];
					const mappedList: (string | number)[] = [];
					let rejected = false;
					for (const el of value) {
						if (typeof el === 'string' && byteLength(el) > ctx.limits.maxNoteBytes) {
							v.outcome = outcomeOf(action, 'rejected', `Wert für '${key}' überschreitet maxNoteBytes (${ctx.limits.maxNoteBytes})`);
							rejected = true;
							break;
						}
						if (typeof el === 'string' && table !== undefined) {
							const original = table.fromSlug[el];
							if (original === undefined) {
								v.outcome = outcomeOf(action, 'rejected', `Wert '${el}' für '${key}' nicht in enumerierter Wertemenge`);
								rejected = true;
								break;
							}
							mappedList.push(original);
						} else {
							mappedList.push(el);
						}
					}
					if (rejected) return v;
					mapped[key] = mappedList;
					continue;
				}
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
```

In `src/core/ports.ts`, change the `patchFrontmatter` signature `set: Record<string, string | number | null>` to `set: Record<string, FmValue>` (import `FmValue` from `./types`).

In `src/obsidian/vault-port.ts`, change the `patchFrontmatter` parameter type the same way (`Record<string, FmValue>`, import from `../core/types`). `processFrontMatter`'s callback already assigns values verbatim — no logic change; if the assignment is typed, widen it to accept `FmValue`.

- [ ] **Step 9: Run the full gate**

Run: `npm run gate`
Expected: PASS (exit 0) — schema + executor array tests green, all scalar regressions green.

- [ ] **Step 10: Commit**

```bash
git add src/core/types.ts src/core/schemas.ts src/core/action-executor.ts src/core/ports.ts src/obsidian/vault-port.ts tests/core/schemas.test.ts tests/core/action-executor.test.ts
git commit -m "feat(frontmatter): Listen-Werte in frontmatter.set/patch

FmValue-Typ (Skalar oder Liste-von-Skalaren) durch Typ/validate/executor/port.
Array-Werte werden elementweise validiert (Slug-Enum je Element) und
zurückgemappt; Skalar-Verhalten unverändert. processFrontMatter schreibt Listen.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Prompt-Hilfe (`outputExample`) + Notiz-Tagger auf Liste

**Files:**
- Modify: `src/core/schemas.ts` (`frontmatter.set` `outputExample`)
- Modify: `src/obsidian/example-assets.ts` (`NOTIZ_TAGGER_AGENT` + `NOTIZ_TAGGER_TEAM` instruction)
- Modify: `assets/examples/agents/notiz-tagger.md`, `assets/examples/teams/notiz-tagger.md` (byte-identisch)
- Test: `tests/obsidian/install-examples.test.ts`

**Interfaces:**
- Consumes: `FmValue`/array support (Task 1)

- [ ] **Step 1: Update the `outputExample`**

In `src/core/schemas.ts`, in `makeFrontmatterSet`, change `outputExample` to show a list field:

```typescript
		outputExample: '{"items": [{"path": "10_Aufgaben/beispiel.md", "set": {"priority": "mittel", "tags": ["arbeit", "notiz"]}}]}',
```

- [ ] **Step 2: Update the Notiz-Tagger to ask for a list (TS constant)**

In `src/obsidian/example-assets.ts`, in `NOTIZ_TAGGER_TEAM`'s `instruction`, make the list explicit — change the tag line to:

```
      Notiz 2–4 knappe, thematische Tags **als Liste** vor, abgeleitet ausschließlich
```

And in `NOTIZ_TAGGER_AGENT`'s body, change the tags sentence to end with: `… je ein Wort oder ein kurzer bindestrich-getrennter Begriff, und lieferst sie als Liste.` (Keep wording minimal; the point is the model must return a JSON array for `tags`.)

- [ ] **Step 3: Mirror to disk byte-identically**

Update `assets/examples/agents/notiz-tagger.md` and `assets/examples/teams/notiz-tagger.md` so each is byte-identical to its TS constant's string body (same edits, literal backticks, same trailing newline).

- [ ] **Step 4: Run the install-examples test**

Run: `npx vitest run tests/obsidian/install-examples.test.ts`
Expected: PASS — Notiz-Tagger still parses `ok:true`; byte-identity `it.each` green for the changed files. (If byte-identity fails, fix the disk file to match the constant.)

- [ ] **Step 5: Run the full gate**

Run: `npm run gate`
Expected: PASS (exit 0).

- [ ] **Step 6: Commit**

```bash
git add src/core/schemas.ts src/obsidian/example-assets.ts assets/examples/agents/notiz-tagger.md assets/examples/teams/notiz-tagger.md
git commit -m "feat(examples): Notiz-Tagger liefert tags als Liste + outputExample zeigt Liste

frontmatter.set-outputExample zeigt jetzt ein Listen-Feld; Notiz-Tagger-Prompt
verlangt tags als Liste (nutzt Task-1-Array-Support).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- `FmValue`-Typ durch alle Schichten → Task 1 (types/schemas/executor/ports/vault-port). ✓
- Array-Validierung mit Enum-pro-Element + Nicht-Skalar-Ablehnung → Task 1 Step 4 + Tests. ✓
- Executor elementweises Rückmapping + Byte-Check → Task 1 Step 8. ✓
- Skalar-Rückwärtskompat → Skalar-Zweige unverändert; Regressionstests grün. ✓
- outputExample + Notiz-Tagger-instruction → Task 2. ✓
- Byte-Identität → Task 2 Step 3/4. ✓

**2. Placeholder scan:** Schema-Tests + Code-Blöcke vollständig. Der Executor-Test (Task 1 Step 6) verweist bewusst auf das Bestandsmuster in `action-executor.test.ts` (dessen `ctx`/Slug-Setup nicht dupliziert wird) mit konkreter Assertion — der Implementer übernimmt die reale Helper-Signatur. ✓

**3. Type consistency:** `FmScalar`/`FmValue` (Task 1) einheitlich in set/mappedSet/port. `outputExample`/instruction-Namen (Task 2) konsistent mit den in TP2 angelegten Konstanten (`NOTIZ_TAGGER_AGENT`/`NOTIZ_TAGGER_TEAM`). ✓

**Hinweis für den Executor:** In `action-executor.test.ts` die vorhandene Slug-Mapping-Testhilfe wiederverwenden; die exakte `ctx`-Konstruktion aus der Bestandsdatei übernehmen, nicht neu erfinden.
