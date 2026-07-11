# Crew-Vorlagen + Content-Collector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das TP1-Output-Vokabular mit zwei content-basierten Beispiel-Crews demonstrieren, dafür `tasknotes.query` um ein `include_content`-Flag erweitern, und Crew-Authoring im README dokumentieren.

**Architecture:** Additive Collector-Erweiterung (kein Parser-/Typ-Change, da `params` generisch `Record<string,unknown>` ist), zwei neue Beispiel-Crews als TS-Konstanten + byte-identische Disk-Spiegel, README-Abschnitt. Die Cap-Logik wird aus `vaultRead` in einen geteilten `capContent`-Helper extrahiert (DRY).

**Tech Stack:** TypeScript, Vitest (node-env, Fixtures + InMemoryVaultPort/FixtureMetadataPort), esbuild.

## Global Constraints

- **Gate vor jedem Commit grün:** `npm run gate` = lint + typecheck + test + check:pure. Exit-Code prüfen.
- **`src/core/**` importiert NIE `obsidian`** — `collectors.ts` bleibt pure.
- **TDD:** erst fehlschlagender Test, dann minimale Implementierung.
- **Commit-Stil:** Conventional Commits + Trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Byte-Identität:** Jede Beispiel-Crew existiert doppelt — als TS-Konstante in `src/obsidian/example-assets.ts` UND als Klartext-Datei unter `assets/examples/**`. Beide müssen byte-identisch sein (`install-examples.test.ts` erzwingt es). Achtung beim TS-Template-String: Backticks und `${` im Crew-Text müssen escaped werden (`` \` ``, `\${`).
- **Beispiel-Crews müssen die echten Parser bestehen:** jede neue Crew parst unter den Plugin-Default-Maxima (`maxWrites: 10`) mit `ok:true`, jeder Agent hat `thinking: off` (Reasoning-Modell-Regression).
- **`include_content` Default `false`** → null Verhaltensänderung für bestehende Crews.
- **Kein Release**, aber CHANGELOG `[Unreleased]` pflegen.

---

### Task 1: `include_content` an `tasknotes.query` (+ `capContent`-Helper)

**Files:**
- Modify: `src/core/collectors.ts` (extrahiere `capContent`; `vaultRead` darauf umstellen; `tasknotesQuery` Projektionsstufe)
- Test: `tests/core/collectors.test.ts`

**Interfaces:**
- Produces: `function capContent(full: string, runningTotal: number): { content: string; total: number }` (modul-intern, nicht exportiert)
- `tasknotes.query` akzeptiert `params.include_content: true` → `CollectedFile.content` gefüllt (sonst `null`)

- [ ] **Step 1: Write the failing tests**

Add to `tests/core/collectors.test.ts` inside the `describe('tasknotes.query', ...)` block:

```typescript
	it('include_content liefert Notiz-Text für die gelieferten Notizen', async () => {
		const a = await runCollector(def('tasknotes.query', {
			folder: '10_Aufgaben', include_content: true, sort: 'title', limit: 2,
		}), deps);
		expect(a.files.length).toBe(2);
		expect(a.files.every((f) => typeof f.content === 'string' && (f.content ?? '').length > 0)).toBe(true);
	});

	it('ohne include_content bleibt content null (Default, unverändert)', async () => {
		const a = await runCollector(def('tasknotes.query', { folder: '10_Aufgaben' }), deps);
		expect(a.files.every((f) => f.content === null)).toBe(true);
	});

	it('include_content kappt übergroße Notizen mit Marker', async () => {
		await vault.create('10_Aufgaben/zzz-gross.md', `---\ntitle: zzz\n---\n${'y'.repeat(40_000)}`);
		const a = await runCollector(def('tasknotes.query', {
			folder: '10_Aufgaben', include_content: true, sort: 'title',
		}), deps);
		const gross = a.files.find((f) => f.path.endsWith('zzz-gross.md'));
		expect((gross?.content ?? '').length).toBeLessThan(40_000);
		expect(gross?.content).toContain('[gekürzt]');
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/collectors.test.ts -t include_content`
Expected: FAIL — `content` is `null` even with `include_content: true`.

- [ ] **Step 3: Extract `capContent` and rewire `vaultRead`**

In `src/core/collectors.ts`, add the helper below the `fnv1a` function:

```typescript
/** Kürzt Notiz-Inhalt auf die Per-File- und Total-Caps. Geteilt von vault.read und
 *  tasknotes.query#include_content. Gibt gekürzten Text + neue Laufsumme zurück. */
function capContent(full: string, runningTotal: number): { content: string; total: number } {
	let content = full;
	if (content.length > PER_FILE_CAP) content = content.slice(0, PER_FILE_CAP) + TRUNCATION_MARKER;
	if (runningTotal + content.length > TOTAL_CAP) content = content.slice(0, Math.max(0, TOTAL_CAP - runningTotal)) + TRUNCATION_MARKER;
	return { content, total: runningTotal + content.length };
}
```

Replace the body of the `for (const raw of wanted)` loop in `vaultRead` (the lines from `const full = ...` through `total += content.length;`) so it uses the helper:

```typescript
		const full = await deps.vault.read(path);
		const capped = capContent(full, total);
		total = capped.total;
		files.push({
			path,
			contentHash: fnv1a(full),
			frontmatter: await deps.meta.getFrontmatter(path),
			content: capped.content,
		});
		if (total >= TOTAL_CAP) break;
```

(Delete the now-unused local `let content = full; if (content.length > PER_FILE_CAP) ...` lines and the standalone `total += content.length;`.)

- [ ] **Step 4: Fill content in `tasknotesQuery`**

In `src/core/collectors.ts`, replace the Step-5 projection block (`const files: CollectedFile[] = limited.map(...)` through `return artifact(def.id, files, slugTables);`) with a `for`-loop that honours `include_content`:

```typescript
	// 5. Projektion + Slug-Normalisierung; optional Inhalt (include_content).
	const includeContent = def.params.include_content === true;
	const files: CollectedFile[] = [];
	let contentTotal = 0;
	for (const e of limited) {
		const projected: Record<string, unknown> = {};
		for (const key of fields ?? Object.keys(e.fm)) {
			if (!(key in e.fm)) { projected[key] = null; continue; }
			projected[key] = slugify(e.fm[key], slugTables[key]);
		}
		let content: string | null = null;
		if (includeContent) {
			const capped = capContent(e.raw, contentTotal);
			content = capped.content;
			contentTotal = capped.total;
		}
		files.push({ path: e.path, contentHash: fnv1a(e.raw), frontmatter: projected, content });
	}
	return artifact(def.id, files, slugTables);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/core/collectors.test.ts`
Expected: PASS — new include_content cases green, existing vault.read cap test still green (proves `capContent` refactor is behaviour-preserving).

- [ ] **Step 6: Run the full gate**

Run: `npm run gate`
Expected: PASS (exit 0).

- [ ] **Step 7: Commit**

```bash
git add src/core/collectors.ts tests/core/collectors.test.ts
git commit -m "feat(collectors): include_content an tasknotes.query + capContent-Helper

tasknotes.query liefert bei include_content:true den Notiz-Text (für die
gelieferten Notizen, mit vault.read-Caps). Cap-Logik in capContent extrahiert
und von vault.read + tasknotes.query geteilt. Default false = unverändert.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Zwei neue Beispiel-Crews (Notiz-Tagger + Reifegrad-Tagger)

**Files:**
- Modify: `src/obsidian/example-assets.ts` (2 Agent- + 2 Team-Konstanten)
- Create: `assets/examples/agents/notiz-tagger.md`, `assets/examples/agents/reifegrad-tagger.md`, `assets/examples/teams/notiz-tagger.md`, `assets/examples/teams/reifegrad-tagger.md` (byte-identisch zu den TS-Konstanten)
- Modify: `src/obsidian/install-examples.ts` (4 Assets in die Liste)
- Test: `tests/obsidian/install-examples.test.ts`

**Interfaces:**
- Consumes: `include_content` (Task 1), `output:`-Block-Syntax (TP1)
- Produces: exported consts `NOTIZ_TAGGER_AGENT`, `REIFEGRAD_TAGGER_AGENT`, `NOTIZ_TAGGER_TEAM`, `REIFEGRAD_TAGGER_TEAM`

- [ ] **Step 1: Write the failing test additions**

In `tests/obsidian/install-examples.test.ts`: add the 4 new consts to the import from `example-assets`, extend `EXPECTED_PATHS`, `KNOWN_AGENTS`, the byte-identity `it.each`, and add parser tests. Concretely:

```typescript
// import block — add:
	NOTIZ_TAGGER_AGENT,
	REIFEGRAD_TAGGER_AGENT,
	NOTIZ_TAGGER_TEAM,
	REIFEGRAD_TAGGER_TEAM,

// EXPECTED_PATHS — add:
	`${ROOT}/agents/notiz-tagger.md`,
	`${ROOT}/agents/reifegrad-tagger.md`,
	`${ROOT}/teams/notiz-tagger.md`,
	`${ROOT}/teams/reifegrad-tagger.md`,

// KNOWN_AGENTS — replace with:
const KNOWN_AGENTS = ['triage-analyst', 'briefing-autor', 'notiz-tagger', 'reifegrad-tagger'];

// byte-identity it.each — add rows:
	['assets/examples/agents/notiz-tagger.md', NOTIZ_TAGGER_AGENT],
	['assets/examples/agents/reifegrad-tagger.md', REIFEGRAD_TAGGER_AGENT],
	['assets/examples/teams/notiz-tagger.md', NOTIZ_TAGGER_TEAM],
	['assets/examples/teams/reifegrad-tagger.md', REIFEGRAD_TAGGER_TEAM],
```

Add a new describe block for the parser checks:

```typescript
describe('Neue Tagger-Crews sind nicht tot (echte Parser, Default-Maxima)', () => {
	it.each([
		['notiz-tagger', NOTIZ_TAGGER_AGENT],
		['reifegrad-tagger', REIFEGRAD_TAGGER_AGENT],
	])('%s.md Agent parst mit thinking:off', (id, constant) => {
		const { fm, body } = splitFrontmatter(constant);
		const r = parseAgentDef(`_crews/agents/${id}.md`, fm, body);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(r.value.id).toBe(id);
		expect(r.value.thinking).toBe('off');
	});

	it.each([
		['notiz-tagger', NOTIZ_TAGGER_TEAM, ['tags']],
		['reifegrad-tagger', REIFEGRAD_TAGGER_TEAM, ['reifegrad']],
	])('%s.md Team parst und nutzt frontmatter.set', (id, constant, keys) => {
		const { fm } = splitFrontmatter(constant);
		const r = parseTeamDef(`_crews/teams/${id}.md`, fm, {
			knownAgents: KNOWN_AGENTS,
			maxima: DEFAULT_MAXIMA,
			denylist: DENYLIST,
		});
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(r.value.id).toBe(id);
		expect(r.value.maxWrites).toBeLessThanOrEqual(DEFAULT_MAXIMA.maxWrites);
		const llmTask = r.value.tasks.find((t) => t.kind === 'llm');
		expect(llmTask).toMatchObject({ kind: 'llm', output: { family: 'frontmatter.set', allowedKeys: keys } });
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/obsidian/install-examples.test.ts`
Expected: FAIL — consts not exported / files missing.

- [ ] **Step 3: Add the 4 TS constants to `example-assets.ts`**

Append to `src/obsidian/example-assets.ts` (mind the backtick/`${` escaping inside the template strings — there are none in these texts, but keep it in mind):

```typescript
export const NOTIZ_TAGGER_AGENT = `---
crew-kind: agent
name: Notiz-Tagger
temperature: 0.2
max_tokens: 1024
thinking: off
---
Du bist ein nüchterner Verschlagworter für einen persönlichen Obsidian-Vault. Du
bekommst den Inhalt einzelner Notizen und schlägst pro Notiz 2–4 knappe, thematische
Tags vor: kleingeschrieben, ohne #, je ein Wort oder ein kurzer bindestrich-
getrennter Begriff. Du orientierst dich ausschließlich am Notiz-Inhalt und erfindest
keine Themen. Bei einer inhaltsarmen Notiz schlägst du weniger oder gar keine Tags vor.
`;

export const REIFEGRAD_TAGGER_AGENT = `---
crew-kind: agent
name: Reifegrad-Tagger
temperature: 0.1
max_tokens: 1024
thinking: off
---
Du bist ein nüchterner Reifegrad-Einschätzer für die Notizen eines persönlichen
Obsidian-Vaults. Du bekommst den Inhalt einzelner Notizen und ordnest jeder GENAU
einen Reifegrad zu: „keim" (loser Gedanke, Stichworte), „wachsend" (in Arbeit,
teilausgeführt) oder „reif" (ausgearbeitet, in sich geschlossen). Du nutzt
ausschließlich diese drei Werte und stützt dich nur auf den vorliegenden Inhalt.
Bei zu wenig Inhalt für eine Einschätzung ordnest du nichts zu.
`;

export const NOTIZ_TAGGER_TEAM = `---
crew-kind: team
name: Notiz-Tagger
version: 1
description: Liest Notizen ohne Tags und schlägt 2–4 thematische Tags aus dem Inhalt vor.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "Notizen/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Notizen
      where_missing: [tags]
      limit: 15
      fields: [tags]
      include_content: true
  - id: tag
    kind: llm
    agent: notiz-tagger
    inputs: [collect]
    instruction: |
      Du bekommst Notizen samt Inhalt, die noch keine Tags haben. Schlage pro
      Notiz 2–4 knappe, thematische Tags vor, abgeleitet ausschließlich aus dem
      Inhalt. Erfinde keine Themen; bei inhaltsarmen Notizen weniger oder keine.
    output:
      family: frontmatter.set
      allowed_keys: [tags]
    on_error: abort
  - id: apply
    kind: actions
    inputs: [tag]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [tags]
---
## Notiz-Tagger

Generische, vault-agnostische Beispiel-Crew: findet Notizen **ohne** \`tags\` im
Ordner \`Notizen/\`, liest ihren Inhalt (\`include_content: true\`) und schlägt
2–4 thematische Tags vor (\`frontmatter.set\` mit \`allowed_keys: [tags]\`).

**Vor dem ersten Lauf anpassen:** Trage bei \`params.folder\` UND bei
\`write_scope\` deinen Zielordner ein (beide zeigen bewusst auf denselben Ordner,
damit nicht Notizen gesammelt werden, die außerhalb der Schreibfreigabe liegen).
\`write_scope\` steht absichtlich NICHT auf dem ganzen Vault (\`**/*.md\`), damit ein
frisch installiertes Team nicht versehentlich überall schreibt.
`;

export const REIFEGRAD_TAGGER_TEAM = `---
crew-kind: team
name: Reifegrad-Tagger
version: 1
description: Schätzt den Reifegrad von Notizen aus ihrem Inhalt und schreibt ihn ins Frontmatter.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "20_Zettel/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: 20_Zettel
      where_missing: [reifegrad]
      limit: 15
      fields: [reifegrad]
      include_content: true
  - id: classify
    kind: llm
    agent: reifegrad-tagger
    inputs: [collect]
    instruction: |
      Du bekommst Notizen samt Inhalt, die noch keinen Reifegrad haben. Ordne
      jeder GENAU einen Reifegrad zu: keim, wachsend oder reif. Nutze nur diese
      drei Werte. Bei zu wenig Inhalt: nichts zuordnen.
    output:
      family: frontmatter.set
      allowed_keys: [reifegrad]
    on_error: abort
  - id: apply
    kind: actions
    inputs: [classify]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [reifegrad]
---
## Reifegrad-Tagger

Pallas-Demo: schätzt für die Zettel in \`20_Zettel/\` einen Reifegrad
(\`keim\`/\`wachsend\`/\`reif\`) aus dem Inhalt und schreibt ihn ins Frontmatter
(\`frontmatter.set\` mit \`allowed_keys: [reifegrad]\`, \`include_content: true\`).

**Bewusste Limitation — Wertebeschränkung nur aus dem Prompt:** \`frontmatter.set\`
+ \`allowed_keys\` beschränkt, WELCHE Felder gesetzt werden, aber nicht die
erlaubten WERTE eines Feldes. Die strukturelle Enum-Erzwingung (Slug-Wertemenge)
greift erst, wenn \`reifegrad\` im Ordner bereits Ist-Werte hat. Beim allerersten
Lauf kommt die Beschränkung auf \`keim/wachsend/reif\` daher nur aus der Instruktion
und dem Agent-Prompt. „Erlaubte Werte pro Feld" ist bewusst noch kein Feature.
`;
```

- [ ] **Step 4: Create the 4 byte-identical disk mirrors**

Create each file under `assets/examples/` with content **byte-identical** to the corresponding TS constant's string value (i.e. the text between the backticks, un-escaped — a literal backtick in the file, not `` \` ``). Files: `assets/examples/agents/notiz-tagger.md`, `assets/examples/agents/reifegrad-tagger.md`, `assets/examples/teams/notiz-tagger.md`, `assets/examples/teams/reifegrad-tagger.md`. (These texts contain no `${`; they do contain literal backticks around inline code — write those as plain backticks on disk.)

- [ ] **Step 5: Register the 4 assets in `install-examples.ts`**

In `src/obsidian/install-examples.ts`, import the 4 new consts and add them to the `assets` array:

```typescript
    { path: `${base}/agents/notiz-tagger.md`, content: NOTIZ_TAGGER_AGENT },
    { path: `${base}/agents/reifegrad-tagger.md`, content: REIFEGRAD_TAGGER_AGENT },
    { path: `${base}/teams/notiz-tagger.md`, content: NOTIZ_TAGGER_TEAM },
    { path: `${base}/teams/reifegrad-tagger.md`, content: REIFEGRAD_TAGGER_TEAM },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/obsidian/install-examples.test.ts`
Expected: PASS — all installed, byte-identical, parsers green. If a byte-identity row fails, the disk file and the TS constant differ (whitespace/newline) — fix the disk file to match exactly.

- [ ] **Step 7: Run the full gate**

Run: `npm run gate`
Expected: PASS (exit 0).

- [ ] **Step 8: Commit**

```bash
git add src/obsidian/example-assets.ts src/obsidian/install-examples.ts assets/examples/ tests/obsidian/install-examples.test.ts
git commit -m "feat(examples): Notiz-Tagger + Reifegrad-Tagger Beispiel-Crews

Zwei content-basierte Crews, die das TP1-output:-Vokabular demonstrieren:
generischer Notiz-Tagger (vault-agnostisch) + Pallas-Reifegrad-Tagger, beide
frontmatter.set + include_content. TS-Konstanten + byte-identische Disk-Spiegel.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: README-Doku „Eigene Crews schreiben" + CHANGELOG

**Files:**
- Modify: `README.md` (neuer Abschnitt)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

**Interfaces:** none (docs only)

- [ ] **Step 1: Add the README section**

In `README.md`, after the „V1 limitations" section (or the most fitting existing spot — place it near the crew documentation), add:

```markdown
## Eigene Crews schreiben

Eine Crew ist Markdown im Vault: ein **Team** (`crew-kind: team`) als Pipeline aus
`collector → llm → actions`, plus **Agent**-Notes (`crew-kind: agent`, System-Prompt
im Body). Die mitgelieferten Crews (Command „Install example crews") sind editierbare
Beispiele — kopiere und passe sie an.

### Output-Vokabular (`output:`)

Ein `llm`-Task legt sein Ausgabeformat über einen `output:`-Block fest:

- **`frontmatter.set`** — das Modell schlägt Frontmatter-Werte für Quell-Notizen vor.
  `allowed_keys` beschränkt, welche Felder gesetzt werden dürfen. Pfade sind an das
  Quellmaterial gebunden (keine Halluzination), Enum-Werte an die im Vault
  vorhandenen Werte.
  ```yaml
  output:
    family: frontmatter.set
    allowed_keys: [tags, kategorie]
  ```
- **`section.write`** — das Modell schreibt Markdown-Text, der per `section.replace`
  in das `target` des nachgelagerten `actions`-Tasks geschrieben wird. Optional
  `max_chars` (Default 16000).
  ```yaml
  output:
    family: section.write
  ```

Die älteren Namen `output_schema: triage-v1` / `briefing-v1` bleiben als Kurzform gültig.

### Inhalt lesen (`include_content`)

Standardmäßig liefert `tasknotes.query` nur Frontmatter. Für Crews, die den
Notiz-**Text** brauchen (Tagger, Zusammenfasser), setze `include_content: true`:

```yaml
collector: tasknotes.query
params:
  folder: Notizen
  where_missing: [tags]
  include_content: true
```

### Schreib-Sicherheit (`write_scope`)

`write_scope` ist eine Glob-Allowlist: eine Crew darf nur dort schreiben. Setze sie
so eng wie möglich — und lass `collector`-`folder` und `write_scope` auf denselben
Ordner zeigen, sonst werden Vorschläge außerhalb der Schreibfreigabe verworfen. Das
Plugin-Limit „Max. Schreibvorgänge pro Lauf" deckelt zusätzlich jeden `max_writes`-Wert.
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]` (create the section if absent, above the latest released version), add:

```markdown
### Added
- `tasknotes.query` unterstützt `include_content: true` (liefert Notiz-Inhalt für die gelieferten Notizen).
- Zwei neue Beispiel-Crews: **Notiz-Tagger** (generisch, vault-agnostisch) und **Reifegrad-Tagger** (Pallas-Demo) — demonstrieren das `output:`-Vokabular (`frontmatter.set`) mit Inhalt.
- README-Abschnitt „Eigene Crews schreiben" (output:-Syntax, include_content, write_scope).
```

- [ ] **Step 3: Verify docs build / no broken references**

Run: `npm run gate`
Expected: PASS (exit 0) — docs don't affect tests, but confirms nothing regressed.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(readme): Abschnitt 'Eigene Crews schreiben' + CHANGELOG

Dokumentiert output:-Vokabular (frontmatter.set/section.write), include_content
und das write_scope-Sicherheitsmodell. CHANGELOG [Unreleased] für TP1+TP2.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Teil A `include_content` + `capContent`-Refactor → Task 1. ✓
- Teil B Notiz-Tagger (generisch) + Reifegrad-Tagger (Pallas), beide frontmatter.set + include_content → Task 2. ✓
- `folder`/`write_scope` konsistent auf denselben Ordner → Task 2 (Notiz-Tagger-Prosa + Werte). ✓
- Byte-Identität TS ↔ Disk → Task 2 Step 3/4 + Test. ✓
- Parser-grün unter Default-Maxima + thinking:off → Task 2 Step 1 Parser-Tests. ✓
- allowed_values-Limitation dokumentiert → Task 2 Reifegrad-Prosa. ✓
- Teil C README + CHANGELOG → Task 3. ✓
- Bestehende Crews unverändert → kein Task ändert sie. ✓
- Kein Parser/Typ-Change für include_content → Task 1 fasst nur collectors.ts an. ✓

**2. Placeholder scan:** Alle Crew-Texte, Test- und README-Blöcke vollständig ausgeschrieben. Kein TBD/TODO. ✓

**3. Type consistency:** `capContent(full, runningTotal) → {content, total}` in Task 1 definiert, in `vaultRead` + `tasknotesQuery` gleich genutzt. Const-Namen (`NOTIZ_TAGGER_AGENT` etc.) in Task 2 durchgängig zwischen `example-assets.ts`, `install-examples.ts`, Test-Import und byte-identity-Rows identisch. `output: { family, allowedKeys }` (camelCase im geparsten Ergebnis) vs. `allowed_keys` (snake im YAML) — konsistent mit TP1. ✓

**Hinweis für den Executor:** Beim Prüfen der Byte-Identität ist der TS-Template-String die Quelle; die Disk-Datei muss exakt den entfetteten String enthalten (literale Backticks, keine `\``-Escapes). Der `install-examples.test.ts`-`it.each` fängt jede Abweichung.
