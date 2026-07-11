# `create_if_missing` für `section.replace` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Task-Level-Flag `create_if_missing` verdrahten, das `section.replace` erlaubt, ein fehlendes Ziel selbst anzulegen (Marker-Block) statt kontrolliert zu failen.

**Architecture:** Der Flag lebt auf `ActionsTaskDef`, wird aus der Crew-Markdown geparst und im Executor über den bereits vorhandenen `ctx.task` gelesen. Fehlende Elternordner legt ein rekursiv gemachtes `vault.mkdir` an. Undo ist automatisch korrekt (`preWrite` erfasst `existedBefore=false` → Snapshot trasht die neue Datei).

**Tech Stack:** TypeScript, Vitest (node-env), esbuild. Kein neuer Dependency.

## Global Constraints

- `src/core/**` importiert NIE `obsidian` (CI-Gate `check:pure`).
- **Gate vor jedem Commit grün:** `npm run gate` (lint + typecheck + test + check:pure). Exit-Code prüfen (`echo $?`), nicht grep-Ausgabe.
- **TDD:** erst fehlschlagender Test, dann minimale Implementierung.
- **Commit-Trailer exakt:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Kein Verhaltenswechsel für bestehende Crews:** Default `false` — fehlt der Schlüssel, gilt der bisherige kontrollierte Fail.
- **Kein Template, kein `note.append`-Support** (YAGNI, s. Spec). Nur `section.replace`.

---

### Task 1: `createIfMissing` auf `ActionsTaskDef` + Crew-Parser

**Files:**
- Modify: `src/core/types.ts:33-40` (Feld ergänzen)
- Modify: `src/core/crew-parser.ts:121-134` (parsen + im push setzen)
- Test: `tests/core/crew-parser.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `ActionsTaskDef.createIfMissing: boolean` (Pflichtfeld; Parser setzt immer, Default `false`).

- [ ] **Step 1: Failing-Tests schreiben**

In `tests/core/crew-parser.test.ts`, innerhalb `describe('parseTeamDef', …)` (nach dem „parst gültiges Team"-Test) einfügen:

```ts
	it('parst create_if_missing: true auf actions-Task', () => {
		const tasks = [
			{ id: 'collect', kind: 'collector', collector: 'tasknotes.query', params: { folder: '10_Aufgaben' } },
			{ id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'B.', output_schema: 'triage-v1' },
			{ id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['section.replace'], target: 'Daily/{{today}}.md', create_if_missing: true },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(r.value.tasks[2]).toMatchObject({ kind: 'actions', createIfMissing: true });
	});

	it('create_if_missing fehlt → Default false', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm(), OPTS);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tasks[2]).toMatchObject({ kind: 'actions', createIfMissing: false });
	});

	it('create_if_missing nicht-boolean → Fehler', () => {
		const tasks = [
			{ id: 'collect', kind: 'collector', collector: 'tasknotes.query', params: { folder: '10_Aufgaben' } },
			{ id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'B.', output_schema: 'triage-v1' },
			{ id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['section.replace'], target: 'Daily/{{today}}.md', create_if_missing: 'yes' },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.some((e) => e.includes('create_if_missing'))).toBe(true);
	});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag verifizieren**

Run: `npx vitest run tests/core/crew-parser.test.ts`
Expected: FAIL — `createIfMissing` existiert nicht auf dem geparsten Task (Typecheck-/Assertion-Fehler).

- [ ] **Step 3: Typ ergänzen**

`src/core/types.ts`, `ActionsTaskDef` (Zeilen 33-40) — Feld anhängen:

```ts
export interface ActionsTaskDef {
	id: string;
	kind: 'actions';
	inputs: string[];
	allowedActions: ActionType[];
	allowedKeys: string[] | null;
	target: string | null;
	createIfMissing: boolean;
}
```

- [ ] **Step 4: Parser ergänzen**

`src/core/crew-parser.ts`, im `case 'actions':`-Block. Ersetze die drei Zeilen (aktuell 131-133):

```ts
					const allowedKeys = Array.isArray(raw.allowed_keys) ? raw.allowed_keys.filter((k): k is string => typeof k === 'string') : null;
					const target = typeof raw.target === 'string' && raw.target.trim() !== '' ? raw.target.trim() : null;
					tasks.push({ id, kind: 'actions', inputs, allowedActions, allowedKeys, target });
```

durch:

```ts
					const allowedKeys = Array.isArray(raw.allowed_keys) ? raw.allowed_keys.filter((k): k is string => typeof k === 'string') : null;
					const target = typeof raw.target === 'string' && raw.target.trim() !== '' ? raw.target.trim() : null;
					if (raw.create_if_missing !== undefined && typeof raw.create_if_missing !== 'boolean') {
						err(`${label}.create_if_missing`, `'${show(raw.create_if_missing)}' (erwartet true|false)`);
					}
					const createIfMissing = raw.create_if_missing === true;
					tasks.push({ id, kind: 'actions', inputs, allowedActions, allowedKeys, target, createIfMissing });
```

- [ ] **Step 5: Tests laufen lassen, grün verifizieren**

Run: `npx vitest run tests/core/crew-parser.test.ts`
Expected: PASS (3 neue Tests + alle bestehenden).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/crew-parser.ts tests/core/crew-parser.test.ts
git commit -m "$(cat <<'EOF'
feat(crew-parser): create_if_missing-Flag auf ActionsTaskDef parsen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `ObsidianVaultPort.mkdir` rekursiv machen

**Warum:** Obsidians `adapter.mkdir` ist nicht rekursiv (s. `snapshot-store.ts:82` `ensureDir`). Damit `create_if_missing` ein Ziel in einem tieferen, noch nicht existenten Ordner anlegen kann, muss `vault.mkdir` fehlende Ancestor-Ordner selbst erzeugen. Der Port ist der richtige Ort (ein Vertrag für alle Caller); bestehende Caller (`orchestrator.ts:490/506` in `try/catch`, `install-examples.ts:23-25`) profitieren oder sind indifferent.

**Files:**
- Modify: `src/obsidian/vault-port.ts:44-48` (`mkdir`)
- Test: `tests/obsidian/vault-port.test.ts`

**Interfaces:**
- Consumes: `app.vault.adapter.exists`/`.mkdir` (Obsidian-API).
- Produces: `VaultPort.mkdir` legt den Ordner UND fehlende Ancestor-Ordner an (idempotent). Konsumiert von Task 3.

- [ ] **Step 1: Failing-Test schreiben**

In `tests/obsidian/vault-port.test.ts`, nach dem bestehenden `it('mkdir ist idempotent …')`:

```ts
  it('mkdir legt fehlende Ancestor-Ordner rekursiv an (adapter.mkdir ist nicht rekursiv)', async () => {
    const existing = new Set<string>();
    app.vault.adapter.exists = vi.fn().mockImplementation((p: string) => Promise.resolve(existing.has(p)));
    const made: string[] = [];
    app.vault.adapter.mkdir = vi.fn().mockImplementation((p: string) => { made.push(p); existing.add(p); return Promise.resolve(); });
    await new ObsidianVaultPort(app).mkdir("Daily/2026//07");
    expect(made).toEqual(["Daily", "Daily/2026", "Daily/2026/07"]);
  });
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag verifizieren**

Run: `npx vitest run tests/obsidian/vault-port.test.ts`
Expected: FAIL — heutiges `mkdir` legt nur `Daily/2026/07` an (`made` = `["Daily/2026/07"]`), nicht die Ancestor-Kette.

- [ ] **Step 3: `mkdir` rekursiv machen**

`src/obsidian/vault-port.ts`, `mkdir` (Zeilen 44-48). Ersetze:

```ts
  async mkdir(path: string): Promise<void> {
    const np = normalizePath(path);
    if (await this.app.vault.adapter.exists(np)) return; // idempotent
    await this.app.vault.adapter.mkdir(np);
  }
```

durch:

```ts
  async mkdir(path: string): Promise<void> {
    const np = normalizePath(path);
    if (np === "" || (await this.app.vault.adapter.exists(np))) return; // idempotent
    const parent = np.slice(0, np.lastIndexOf("/"));
    if (parent !== "" && parent !== np) await this.mkdir(parent); // adapter.mkdir ist nicht rekursiv
    await this.app.vault.adapter.mkdir(np);
  }
```

- [ ] **Step 4: Tests laufen lassen, grün verifizieren**

Run: `npx vitest run tests/obsidian/vault-port.test.ts`
Expected: PASS. Der bestehende „mkdir ist idempotent"-Test bleibt grün (bei `exists=true` kehrt `mkdir` sofort zurück; die `toHaveBeenCalledWith`-Assertion des false-Zweigs trifft weiterhin zu).

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/vault-port.ts tests/obsidian/vault-port.test.ts
git commit -m "$(cat <<'EOF'
fix(vault-port): mkdir legt fehlende Ancestor-Ordner rekursiv an

Obsidians adapter.mkdir ist nicht rekursiv — nötig, damit create_if_missing
ein Ziel in einem noch nicht existenten Ordner anlegen kann.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Executor legt Ziel an, wenn `createIfMissing` gesetzt

**Files:**
- Modify: `src/core/action-executor.ts:142-146` (validate) und `:222-225` (apply)
- Test: `tests/core/action-executor.test.ts` (inkl. `makeTask`-Helper anpassen)

**Interfaces:**
- Consumes: `ActionsTaskDef.createIfMissing` (Task 1) über `ctx.task.createIfMissing`; `vault.mkdir` (rekursiv, Task 2); `vault.create`/`vault.exists` (bestehender `VaultPort`).
- Produces: keine neue öffentliche API.

- [ ] **Step 1: `makeTask`-Helper um Default ergänzen (Typecheck-Fix für Task-1-Feld)**

In `tests/core/action-executor.test.ts`, `makeTask` (Zeilen 25-31) — `createIfMissing: false` im Default ergänzen:

```ts
function makeTask(overrides: Partial<ActionsTaskDef> = {}): ActionsTaskDef {
  return {
    id: 'apply', kind: 'actions', inputs: ['analyse'],
    allowedActions: ['frontmatter.patch', 'note.create', 'note.append', 'section.replace'],
    allowedKeys: ['priority', 'kontext'], target: null, createIfMissing: false, ...overrides,
  };
}
```

- [ ] **Step 2: Failing-Tests schreiben**

In `tests/core/action-executor.test.ts` ein neues `describe` am Dateiende:

```ts
describe('executeActions — section.replace create_if_missing', () => {
  const daily = 'Daily/2026-07-11.md';
  const marker = CREW_MARKER('task-triage');

  it('legt fehlendes Ziel an (Marker-Block), Aktion applied', async () => {
    const vault = new InMemoryVaultPort();
    const action: Action = { type: 'section.replace', path: daily, content: 'Briefing.' };
    const ctx = ctxOf([], { task: makeTask({ createIfMissing: true }), preWrite: async () => {} });
    const res = await executeActions([action], ctx, vault);
    expect(res.outcomes[0].result).toBe('applied');
    expect(await vault.exists(daily)).toBe(true);
    const body = await vault.read(daily);
    expect(body).toContain(marker.start);
    expect(body).toContain('Briefing.');
    expect(body).toContain(marker.end);
    expect(body.startsWith('\n')).toBe(false); // keine führende Leerzeile im frischen File
  });

  it('ohne Flag: fehlendes Ziel weiterhin failed', async () => {
    const vault = new InMemoryVaultPort();
    const action: Action = { type: 'section.replace', path: daily, content: 'x' };
    const ctx = ctxOf([], { task: makeTask({ createIfMissing: false }), preWrite: async () => {} });
    const res = await executeActions([action], ctx, vault);
    expect(res.outcomes[0].result).toBe('failed');
    expect(res.taskFailed).toBe(true);
    expect(await vault.exists(daily)).toBe(false);
  });

  it('legt fehlenden Elternordner via mkdir an (nested Pfad)', async () => {
    const vault = new InMemoryVaultPort();
    const mkdirs: string[] = [];
    const spied: VaultPort = { ...spyVault(vault).vault, mkdir: async (p) => { mkdirs.push(p); await vault.mkdir(p); } };
    const nested = 'Daily/2026/07/2026-07-11.md';
    const action: Action = { type: 'section.replace', path: nested, content: 'x' };
    const ctx = ctxOf([], { task: makeTask({ createIfMissing: true }), preWrite: async () => {} });
    const res = await executeActions([action], ctx, spied);
    expect(res.outcomes[0].result).toBe('applied');
    expect(mkdirs).toContain('Daily/2026/07');
  });

  it('preWrite wird für die neue Datei mit existedBefore=false aufgerufen (→ Undo trasht sie)', async () => {
    const vault = new InMemoryVaultPort();
    const seen: Array<{ path: string; existedBefore: boolean }> = [];
    const action: Action = { type: 'section.replace', path: daily, content: 'x' };
    const ctx = ctxOf([], {
      task: makeTask({ createIfMissing: true }),
      preWrite: async (p) => { seen.push({ path: p, existedBefore: await vault.exists(p) }); },
    });
    await executeActions([action], ctx, vault);
    expect(seen).toContainEqual({ path: daily, existedBefore: false });
  });
});
```

Hinweis: `spyVault` (bestehender Helper, Datei-oben) liefert eine `VaultPort`-Kopie; wir überschreiben nur `mkdir`, um Aufrufe zu sammeln. `preWrite` wird pro Test in den `ctxOf`-Overrides gesetzt (Default-`ctxOf` hat keinen). `VaultPort` ist bereits importiert.

- [ ] **Step 3: Tests laufen lassen, Fehlschlag verifizieren**

Run: `npx vitest run tests/core/action-executor.test.ts`
Expected: FAIL — „legt fehlendes Ziel an"/„mkdir"/„preWrite" scheitern (Validierung liefert heute unbedingt `failed`); „ohne Flag" ist bereits grün.

- [ ] **Step 4: Validierung anpassen**

`src/core/action-executor.ts`, `else`-Zweig `// section.replace` (Zeilen 142-146). Ersetze:

```ts
	} else {
		// section.replace
		if (!(await vault.exists(v.path))) {
			v.outcome = outcomeOf(action, 'failed', `Ziel existiert nicht: ${v.path} — zuerst anlegen (create_if_missing: false)`);
			return v;
		}
```

durch:

```ts
	} else {
		// section.replace
		if (!(await vault.exists(v.path)) && ctx.task.createIfMissing !== true) {
			v.outcome = outcomeOf(action, 'failed', `Ziel existiert nicht: ${v.path} — zuerst anlegen (create_if_missing: false)`);
			return v;
		}
```

- [ ] **Step 5: Apply anpassen**

`src/core/action-executor.ts`, `applyAction`, letzter `else`-Zweig (Zeilen 222-225). Ersetze:

```ts
	} else {
		const current = await vault.read(v.path);
		await vault.modify(v.path, replaceSection(current, ctx.team.id, action.content));
	}
```

durch:

```ts
	} else {
		if (!(await vault.exists(v.path))) {
			const parent = v.path.slice(0, v.path.lastIndexOf('/'));
			if (parent !== '') await vault.mkdir(parent); // mkdir ist idempotent + rekursiv (VaultPort)
			// replaceSection('') erzeugt einen führenden Zeilenumbruch (Append-Semantik) —
			// im frisch angelegten File unerwünscht, daher strippen.
			await vault.create(v.path, replaceSection('', ctx.team.id, action.content).replace(/^\n/, ''));
			return;
		}
		const current = await vault.read(v.path);
		await vault.modify(v.path, replaceSection(current, ctx.team.id, action.content));
	}
```

- [ ] **Step 6: Tests laufen lassen, grün verifizieren**

Run: `npx vitest run tests/core/action-executor.test.ts`
Expected: PASS (4 neue Tests + alle bestehenden section.replace-Tests unverändert grün).

- [ ] **Step 7: Commit**

```bash
git add src/core/action-executor.ts tests/core/action-executor.test.ts
git commit -m "$(cat <<'EOF'
feat(executor): section.replace legt fehlendes Ziel an bei create_if_missing

Elternordner via rekursivem mkdir, frischer File mit Marker-Block (ohne führende
Leerzeile). Undo trasht die neue Datei automatisch (preWrite erfasst existedBefore=false).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Daily-Briefing-Beispiel-Crew nutzt `create_if_missing` + CHANGELOG

**Files:**
- Modify: `src/obsidian/example-assets.ts:138-153` (Flag + Prosa)
- Modify: `CHANGELOG.md:7` (`[Unreleased]`)
- Test: `tests/obsidian/install-examples.test.ts` (Assertion ergänzen)

**Interfaces:**
- Consumes: das geparste `createIfMissing` (Task 1) — die Beispiel-Crew wird beim Install geparst.
- Produces: nichts (Doku/Config).

- [ ] **Step 1: Failing-Test schreiben**

In `tests/obsidian/install-examples.test.ts`, beim bestehenden `applyTask`-Check (Zeile 177) die Assertion erweitern:

```ts
		expect(applyTask).toMatchObject({ kind: 'actions', allowedActions: ['section.replace'], createIfMissing: true });
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag verifizieren**

Run: `npx vitest run tests/obsidian/install-examples.test.ts`
Expected: FAIL — die Beispiel-Crew setzt `create_if_missing` noch nicht (`createIfMissing: false`).

- [ ] **Step 3: Beispiel-Crew umstellen**

`src/obsidian/example-assets.ts`, im `apply`-Task der Daily-Briefing-Crew (Zeilen 138-142). Ersetze:

```ts
  - id: apply
    kind: actions
    inputs: [briefing]
    allowed_actions: [section.replace]
    target: "30_Chronos/10_Tage/{{today}}.md"
```

durch:

```ts
  - id: apply
    kind: actions
    inputs: [briefing]
    allowed_actions: [section.replace]
    target: "30_Chronos/10_Tage/{{today}}.md"
    create_if_missing: true
```

- [ ] **Step 4: Prosa anpassen**

`src/obsidian/example-assets.ts`, Zeilen 149-153. Ersetze den Absatz:

```ts
den Markern \`<!-- crew:daily-briefing -->\` … \`<!-- /crew:daily-briefing -->\`;
existiert die Ziel-Datei nicht, schlägt der Task kontrolliert fehl (kein
\`create_if_missing\`, Spec §4.3) – lege die heutige Daily Note vorher an
(Periodic-Notes-Command oder von Hand).
```

durch:

```ts
den Markern \`<!-- crew:daily-briefing -->\` … \`<!-- /crew:daily-briefing -->\`.
Dank \`create_if_missing: true\` wird die heutige Daily Note angelegt, falls sie
noch nicht existiert (nur der Marker-Block, kein Template). Ein Undo entfernt die
so erzeugte Note wieder (Papierkorb).
```

- [ ] **Step 5: CHANGELOG ergänzen**

`CHANGELOG.md`, `## [Unreleased]` (Zeile 7) ersetzen durch:

```markdown
## [Unreleased]

### Added

- `create_if_missing`-Flag für `section.replace`-Tasks in Crews: legt die Zieldatei
  (Marker-Block, kein Template) samt fehlender Elternordner an, statt kontrolliert zu
  failen. Die Daily-Briefing-Beispiel-Crew nutzt es und braucht die heutige Daily Note
  nicht mehr vorab. Undo entfernt die erzeugte Note (Papierkorb).
```

- [ ] **Step 6: Test + Gate laufen lassen**

Run: `npx vitest run tests/obsidian/install-examples.test.ts`
Expected: PASS.

Run: `npm run gate`
Expected: Exit-Code 0 (lint + typecheck + test + check:pure grün).

- [ ] **Step 7: Commit**

```bash
git add src/obsidian/example-assets.ts CHANGELOG.md tests/obsidian/install-examples.test.ts
git commit -m "$(cat <<'EOF'
feat(examples): Daily-Briefing nutzt create_if_missing + CHANGELOG

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec-Coverage:**
- `ActionsTaskDef.createIfMissing` (Default false) → Task 1 Steps 3-4. ✓
- Parser (boolean, Default false, Typ-Fehler) → Task 1 Steps 1,4. ✓
- Nested Pfad / mkdir rekursiv → Task 2 (Port) + Task 3 Step 5 (Aufruf) + Tests. ✓
- section.replace ohne Flag failed / mit Flag angelegt → Task 3 Steps 2,4,5. ✓
- Undo trasht erzeugte Datei → Task 3 preWrite-Test (existedBefore=false) + bestehende buildUndoPlan-Coverage. ✓
- Beispiel-Crew nutzt Flag + Prosa angepasst → Task 4 Steps 3-4. ✓
- CHANGELOG [Unreleased] → Task 4 Step 5. ✓
- `npm run gate` → Task 4 Step 6. ✓

**Placeholder-Scan:** kein TBD/TODO; jeder Code-Step zeigt vollständigen Code. ✓

**Typ-Konsistenz:** `createIfMissing: boolean` in types.ts (Task 1), gesetzt in crew-parser (Task 1) und makeTask (Task 3), gelesen als `ctx.task.createIfMissing` (Task 3), asserted `createIfMissing: true/false` (Tasks 1,4). `vault.mkdir`-Signatur unverändert (`(path: string) => Promise<void>`), nur Semantik rekursiv. Durchgehend konsistent. ✓

**Bekannte Kopplung:** Nur zwei getypte `ActionsTaskDef`-Literale (`crew-parser.ts:133`, `makeTask`) brauchen das neue Pflichtfeld — beide in Task 1/3 gesetzt. Rohe Crew-Objekte in anderen Tests (snake_case) sind Input-Daten, kein Break. `vault.mkdir` rekursiv zu machen ist für alle bestehenden Caller (`orchestrator` in try/catch, `install-examples`) sicher.
