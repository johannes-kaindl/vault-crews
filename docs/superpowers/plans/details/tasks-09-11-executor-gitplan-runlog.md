Note: claude-opus-4-8[1m] (the safety classifier) was unavailable when reviewing this subagent's work. Please carefully verify the subagent's actions and output before acting on them.

### Task 9: ActionExecutor — Guards, Limits, Stale-Guard, Konsistenz-Schwelle (zweiphasig)

**Files:**
- Create: `src/core/action-executor.ts`
- Test: `tests/core/action-executor.test.ts`

**Interfaces:**
- **Consumes** (aus Task 3): Typen `Action`, `ActionOutcome`, `ActionsTaskDef`, `CollectedFile`, `RunLimits`, `SlugTableData`, `TeamDef` aus `src/core/types.ts`; `VaultPort` aus `src/core/ports.ts`; `normalizeVaultPath(p: string): string` (wirft bei `'..'`), `globMatch(pattern: string, path: string): boolean`, `isDenied(path: string): boolean` aus `src/core/paths.ts`; Test-Helper `InMemoryVaultPort` aus `tests/helpers/in-memory-vault.ts` (wird ausschließlich über die `VaultPort`-Schnittstelle benutzt). Aus Task 6: `fnv1a(s: string): string` aus `src/core/collectors.ts`.
- **Produces** (für Task 13 Orchestrator, Task 19 Golden-Run):
  ```ts
  export interface ExecutorContext { team: TeamDef; task: ActionsTaskDef; limits: RunLimits; writeCount: number; sources: CollectedFile[]; slugTables: Record<string, SlugTableData>; }
  export function executeActions(actions: Action[], ctx: ExecutorContext, vault: VaultPort): Promise<{ outcomes: ActionOutcome[]; writes: string[]; taskFailed: boolean }>;
  export const CREW_MARKER: (teamId: string) => { start: string; end: string };
  ```
  Hinweis: `ExecutorContext` erweitert das Skelett um das Feld `slugTables` — der Executor muss Slug-Werte byte-genau auf die Original-Enum-Werte zurückmappen (Spec §2.5.3) und braucht dafür die Slug-Tabellen der Input-Artefakte. Der Orchestrator (Task 13) befüllt das Feld aus `Artifact.slugTables` der deklarierten `inputs`.

**Semantik (verbindlich für die Implementierung):** Der Executor arbeitet **zweiphasig**. Phase 1 validiert jede Aktion vollständig, ohne zu schreiben, in exakt dieser Reihenfolge: (1) `normalizeVaultPath` — `'..'` → `rejected`; (2) `isDenied` → `rejected`; (3) kein `globMatch`-Treffer gegen `team.writeScope` → `rejected`; (4) Aktionstyp in `task.allowedActions` + typspezifische Checks (`frontmatter.patch`: Keys in `task.allowedKeys`, String-Werte via `slugTables[key].fromSlug` rückgemappt, unbekannter Slug → `rejected`; `note.create`: Ziel existiert nicht, `.md`-Endung, Content ≤ `limits.maxNoteBytes`; `note.append`/`section.replace`: Ziel existiert — fehlendes Ziel → Outcome `failed` mit klarer reason und `taskFailed = true`); (5) Stale-Guard: liegt die Datei in `ctx.sources`, muss `fnv1a(read(path))` dem `contentHash` entsprechen, sonst `stale` (`note.create` ausgenommen); (6) `ctx.writeCount` + bereits budgetierte gültige Aktionen + 1 > `team.maxWrites` → `rejected` mit reason `write_limit` und `taskFailed = true`. Nach Phase 1, **vor dem ersten Write**, greift die Konsistenz-Schwelle: sind mehr als 50 % der Aktionen `rejected`/`stale`, wird `taskFailed = true` gesetzt und **keine** Aktion angewendet (die validen erhalten `rejected` mit `consistency`-reason). Erst Phase 2 schreibt via `VaultPort`; `section.replace` ersetzt idempotent den Block zwischen `<!-- crew:<teamId> -->` und `<!-- /crew:<teamId> -->` und hängt ihn beim ersten Mal mit Leerzeile ans Dateiende an.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/action-executor.test.ts
import { describe, expect, it } from 'vitest';
import type { Action, ActionsTaskDef, CollectedFile, RunLimits, TeamDef } from '../../src/core/types';
import type { VaultPort } from '../../src/core/ports';
import { CREW_MARKER, executeActions, type ExecutorContext } from '../../src/core/action-executor';
import { fnv1a } from '../../src/core/collectors';
import { InMemoryVaultPort } from '../helpers/in-memory-vault';

const LIMITS: RunLimits = {
  maxWrites: 10, maxLlmCalls: 4, wallClockMs: 600_000,
  maxNoteBytes: 65_536, callTimeoutMs: 300_000, stallTimeoutMs: 60_000,
};

const TASK_MD = '---\npriority: 1_niedrig_🟢\n---\nInhalt\n';

function makeTeam(overrides: Partial<TeamDef> = {}): TeamDef {
  return {
    id: 'task-triage', name: 'Task-Triage', version: 1, description: '', trigger: 'manual',
    maxWrites: 10, writeScope: ['10_Aufgaben/**/*.md', 'Daily/**/*.md'], tasks: [],
    sourcePath: '_crews/teams/task-triage.md', ...overrides,
  };
}

function makeTask(overrides: Partial<ActionsTaskDef> = {}): ActionsTaskDef {
  return {
    id: 'apply', kind: 'actions', inputs: ['analyse'],
    allowedActions: ['frontmatter.patch', 'note.create', 'note.append', 'section.replace'],
    allowedKeys: ['priority', 'kontext'], target: null, ...overrides,
  };
}

function source(path: string, content: string): CollectedFile {
  return { path, contentHash: fnv1a(content), frontmatter: null, content: null };
}

async function seed(files: Record<string, string>): Promise<InMemoryVaultPort> {
  const vault = new InMemoryVaultPort();
  for (const [p, c] of Object.entries(files)) await vault.create(p, c);
  return vault;
}

function ctxOf(sources: CollectedFile[], overrides: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    team: makeTeam(), task: makeTask(), limits: LIMITS, writeCount: 0, sources,
    slugTables: { priority: { toSlug: { '2_mittel_🟡': 'mittel' }, fromSlug: { mittel: '2_mittel_🟡' } } },
    ...overrides,
  };
}

function spyVault(vault: VaultPort): {
  vault: VaultPort;
  patches: Array<{ path: string; set: Record<string, string | number | null>; remove: string[] }>;
} {
  const patches: Array<{ path: string; set: Record<string, string | number | null>; remove: string[] }> = [];
  return {
    patches,
    vault: {
      read: (p) => vault.read(p),
      create: (p, c) => vault.create(p, c),
      modify: (p, c) => vault.modify(p, c),
      append: (p, c) => vault.append(p, c),
      exists: (p) => vault.exists(p),
      mkdir: (p) => vault.mkdir(p),
      patchFrontmatter: async (p, s, r) => {
        patches.push({ path: p, set: s, remove: r });
        await vault.patchFrontmatter(p, s, r);
      },
    },
  };
}

describe('CREW_MARKER', () => {
  it('liefert start/end-Marker mit teamId', () => {
    expect(CREW_MARKER('task-triage')).toEqual({
      start: '<!-- crew:task-triage -->',
      end: '<!-- /crew:task-triage -->',
    });
  });
});

describe('executeActions — frontmatter.patch', () => {
  it('wendet Patch an und mappt Slug-Werte byte-genau auf Original-Enums zurück', async () => {
    const raw = await seed({ '10_Aufgaben/a.md': TASK_MD });
    const { vault, patches } = spyVault(raw);
    const action: Action = { type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { priority: 'mittel' }, remove: [] };
    const res = await executeActions([action], ctxOf([source('10_Aufgaben/a.md', TASK_MD)]), vault);
    expect(res.taskFailed).toBe(false);
    expect(res.outcomes).toEqual([{ action, result: 'applied', reason: null }]);
    expect(res.writes).toEqual(['10_Aufgaben/a.md']);
    expect(patches).toEqual([{ path: '10_Aufgaben/a.md', set: { priority: '2_mittel_🟡' }, remove: [] }]);
  });

  it('verwirft Keys außerhalb allowed_keys', async () => {
    const raw = await seed({ '10_Aufgaben/a.md': TASK_MD });
    const { vault, patches } = spyVault(raw);
    const action: Action = { type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { status: 'erledigt' }, remove: [] };
    const res = await executeActions([action], ctxOf([source('10_Aufgaben/a.md', TASK_MD)]), vault);
    expect(res.outcomes[0]?.result).toBe('rejected');
    expect(res.outcomes[0]?.reason).toContain('allowed_keys');
    expect(patches).toEqual([]);
  });

  it('verwirft Slug-Werte außerhalb der enumerierten Wertemenge', async () => {
    const raw = await seed({ '10_Aufgaben/a.md': TASK_MD });
    const { vault, patches } = spyVault(raw);
    const action: Action = { type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { priority: 'dringend' }, remove: [] };
    const res = await executeActions([action], ctxOf([source('10_Aufgaben/a.md', TASK_MD)]), vault);
    expect(res.outcomes[0]?.result).toBe('rejected');
    expect(res.outcomes[0]?.reason).toContain('dringend');
    expect(patches).toEqual([]);
  });

  it('validiert zwei Patches auf dieselbe Datei gegen den Collect-Hash (zweiphasig), writes dedupliziert', async () => {
    const raw = await seed({ '10_Aufgaben/a.md': TASK_MD });
    const { vault, patches } = spyVault(raw);
    const a1: Action = { type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { priority: 'mittel' }, remove: [] };
    const a2: Action = { type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: {}, remove: ['kontext'] };
    const res = await executeActions([a1, a2], ctxOf([source('10_Aufgaben/a.md', TASK_MD)]), vault);
    expect(res.outcomes.map((o) => o.result)).toEqual(['applied', 'applied']);
    expect(res.writes).toEqual(['10_Aufgaben/a.md']);
    expect(patches).toHaveLength(2);
  });
});

describe('executeActions — Pfad-Guards', () => {
  it.each(['../x', '.obsidian/a.md', '_crews/teams/x.md', '10_Aufgaben/../.git/config'])(
    'verwirft bösartigen Pfad %s',
    async (path) => {
      const vault = await seed({});
      const action: Action = { type: 'note.create', path, content: 'x' };
      const res = await executeActions([action], ctxOf([]), vault);
      expect(res.outcomes[0]?.result).toBe('rejected');
      expect(await vault.exists(path)).toBe(false);
    },
  );

  it('verwirft Pfade außerhalb write_scope', async () => {
    const vault = await seed({});
    const action: Action = { type: 'note.create', path: 'Notizen/x.md', content: 'x' };
    const res = await executeActions([action], ctxOf([]), vault);
    expect(res.outcomes[0]?.result).toBe('rejected');
    expect(res.outcomes[0]?.reason).toContain('write_scope');
  });

  it('verwirft Aktionstypen außerhalb allowed_actions', async () => {
    const vault = await seed({});
    const action: Action = { type: 'note.create', path: '10_Aufgaben/neu.md', content: 'x' };
    const res = await executeActions([action], ctxOf([], { task: makeTask({ allowedActions: ['frontmatter.patch'] }) }), vault);
    expect(res.outcomes[0]?.result).toBe('rejected');
    expect(res.outcomes[0]?.reason).toContain('allowed_actions');
  });
});

describe('executeActions — note.create', () => {
  it('legt neue Notiz an', async () => {
    const vault = await seed({});
    const action: Action = { type: 'note.create', path: '10_Aufgaben/neu.md', content: '# Neu\n' };
    const res = await executeActions([action], ctxOf([]), vault);
    expect(res.outcomes[0]?.result).toBe('applied');
    expect(res.writes).toEqual(['10_Aufgaben/neu.md']);
    expect(await vault.read('10_Aufgaben/neu.md')).toBe('# Neu\n');
  });

  it('überschreibt nie existierende Dateien', async () => {
    const vault = await seed({ '10_Aufgaben/neu.md': 'alt' });
    const action: Action = { type: 'note.create', path: '10_Aufgaben/neu.md', content: 'neu' };
    const res = await executeActions([action], ctxOf([]), vault);
    expect(res.outcomes[0]?.result).toBe('rejected');
    expect(await vault.read('10_Aufgaben/neu.md')).toBe('alt');
  });

  it('verwirft Nicht-.md-Pfade', async () => {
    const vault = await seed({});
    const action: Action = { type: 'note.create', path: '10_Aufgaben/x.txt', content: 'x' };
    const res = await executeActions([action], ctxOf([], { team: makeTeam({ writeScope: ['10_Aufgaben/**'] }) }), vault);
    expect(res.outcomes[0]?.result).toBe('rejected');
    expect(res.outcomes[0]?.reason).toContain('.md');
  });

  it('verwirft Content über maxNoteBytes', async () => {
    const vault = await seed({});
    const action: Action = { type: 'note.create', path: '10_Aufgaben/neu.md', content: 'x'.repeat(32) };
    const res = await executeActions([action], ctxOf([], { limits: { ...LIMITS, maxNoteBytes: 16 } }), vault);
    expect(res.outcomes[0]?.result).toBe('rejected');
    expect(res.outcomes[0]?.reason).toContain('maxNoteBytes');
  });
});

describe('executeActions — note.append', () => {
  it('hängt ohne heading ans Dateiende an', async () => {
    const vault = await seed({ 'Daily/2026-07-02.md': '# Daily\n\nText\n' });
    const action: Action = { type: 'note.append', path: 'Daily/2026-07-02.md', heading: null, content: 'Neu' };
    const res = await executeActions([action], ctxOf([]), vault);
    expect(res.outcomes[0]?.result).toBe('applied');
    expect(await vault.read('Daily/2026-07-02.md')).toBe('# Daily\n\nText\nNeu\n');
  });

  it('fügt mit heading ans Section-Ende ein', async () => {
    const vault = await seed({ 'Daily/2026-07-02.md': '# Daily\n\n## Log\n- a\n\n## Sonst\n- b\n' });
    const action: Action = { type: 'note.append', path: 'Daily/2026-07-02.md', heading: 'Log', content: '- neu' };
    const res = await executeActions([action], ctxOf([]), vault);
    expect(res.outcomes[0]?.result).toBe('applied');
    expect(await vault.read('Daily/2026-07-02.md')).toBe('# Daily\n\n## Log\n- a\n- neu\n\n## Sonst\n- b\n');
  });

  it('fehlende Zieldatei → failed mit taskFailed', async () => {
    const vault = await seed({});
    const action: Action = { type: 'note.append', path: 'Daily/2026-07-02.md', heading: null, content: 'x' };
    const res = await executeActions([action], ctxOf([]), vault);
    expect(res.outcomes[0]?.result).toBe('failed');
    expect(res.outcomes[0]?.reason).toContain('existiert nicht');
    expect(res.taskFailed).toBe(true);
  });

  it('fehlendes heading → failed mit taskFailed', async () => {
    const vault = await seed({ 'Daily/2026-07-02.md': '# Daily\n' });
    const action: Action = { type: 'note.append', path: 'Daily/2026-07-02.md', heading: 'Log', content: 'x' };
    const res = await executeActions([action], ctxOf([]), vault);
    expect(res.outcomes[0]?.result).toBe('failed');
    expect(res.taskFailed).toBe(true);
  });
});

describe('executeActions — section.replace', () => {
  const daily = 'Daily/2026-07-02.md';

  it('legt den Marker-Block beim ersten Mal mit Leerzeile ans Dateiende', async () => {
    const vault = await seed({ [daily]: '# Daily\n\nText\n' });
    const action: Action = { type: 'section.replace', path: daily, content: 'Briefing.' };
    const res = await executeActions([action], ctxOf([]), vault);
    expect(res.outcomes[0]?.result).toBe('applied');
    expect(await vault.read(daily)).toBe(
      '# Daily\n\nText\n\n<!-- crew:task-triage -->\nBriefing.\n<!-- /crew:task-triage -->\n',
    );
  });

  it('ersetzt idempotent nur den Marker-Block', async () => {
    const vault = await seed({ [daily]: '# Daily\n\nText\n' });
    const first: Action = { type: 'section.replace', path: daily, content: 'Alt.' };
    await executeActions([first], ctxOf([]), vault);
    const second: Action = { type: 'section.replace', path: daily, content: 'Neu.' };
    await executeActions([second], ctxOf([]), vault);
    const afterSecond = await vault.read(daily);
    expect(afterSecond).toBe('# Daily\n\nText\n\n<!-- crew:task-triage -->\nNeu.\n<!-- /crew:task-triage -->\n');
    await executeActions([second], ctxOf([]), vault);
    expect(await vault.read(daily)).toBe(afterSecond);
  });

  it('fehlende Zieldatei → failed mit klarer reason und taskFailed', async () => {
    const vault = await seed({});
    const action: Action = { type: 'section.replace', path: daily, content: 'x' };
    const res = await executeActions([action], ctxOf([]), vault);
    expect(res.outcomes[0]?.result).toBe('failed');
    expect(res.outcomes[0]?.reason).toContain('zuerst anlegen');
    expect(res.taskFailed).toBe(true);
    expect(await vault.exists(daily)).toBe(false);
  });
});

describe('executeActions — Stale-Guard', () => {
  it('überspringt Aktionen auf zwischenzeitlich geänderten Dateien als stale', async () => {
    const raw = await seed({ '10_Aufgaben/a.md': TASK_MD });
    const src = source('10_Aufgaben/a.md', TASK_MD);
    await raw.modify('10_Aufgaben/a.md', TASK_MD + 'User-Edit\n');
    const { vault, patches } = spyVault(raw);
    const action: Action = { type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { priority: 'mittel' }, remove: [] };
    const res = await executeActions([action], ctxOf([src]), vault);
    expect(res.outcomes[0]?.result).toBe('stale');
    expect(patches).toEqual([]);
    expect(res.taskFailed).toBe(true); // 1/1 stale > 50 % → Konsistenz-Schwelle
  });
});

describe('executeActions — Schreiblimit', () => {
  it('verwirft Aktionen über max_writes mit reason write_limit und taskFailed', async () => {
    const vault = await seed({});
    const a1: Action = { type: 'note.create', path: '10_Aufgaben/n1.md', content: 'x' };
    const a2: Action = { type: 'note.create', path: '10_Aufgaben/n2.md', content: 'x' };
    const res = await executeActions([a1, a2], ctxOf([], { team: makeTeam({ maxWrites: 1 }) }), vault);
    expect(res.outcomes[0]?.result).toBe('applied');
    expect(res.outcomes[1]?.result).toBe('rejected');
    expect(res.outcomes[1]?.reason).toContain('write_limit');
    expect(res.taskFailed).toBe(true);
    expect(await vault.exists('10_Aufgaben/n1.md')).toBe(true);
    expect(await vault.exists('10_Aufgaben/n2.md')).toBe(false);
  });

  it('berücksichtigt bereits verbrauchte writes aus ctx.writeCount', async () => {
    const vault = await seed({});
    const a1: Action = { type: 'note.create', path: '10_Aufgaben/n1.md', content: 'x' };
    const res = await executeActions([a1], ctxOf([], { team: makeTeam({ maxWrites: 1 }), writeCount: 1 }), vault);
    expect(res.outcomes[0]?.result).toBe('rejected');
    expect(res.outcomes[0]?.reason).toContain('write_limit');
    expect(res.taskFailed).toBe(true);
  });
});

describe('executeActions — Konsistenz-Schwelle', () => {
  it('bei > 50 % rejected/stale wird KEINE Aktion angewendet (zweiphasig)', async () => {
    const vault = await seed({});
    const bad1: Action = { type: 'note.create', path: '.obsidian/x.md', content: 'x' };
    const bad2: Action = { type: 'note.create', path: 'Notizen/x.md', content: 'x' };
    const good: Action = { type: 'note.create', path: '10_Aufgaben/neu.md', content: 'x' };
    const res = await executeActions([bad1, bad2, good], ctxOf([]), vault);
    expect(res.taskFailed).toBe(true);
    expect(res.outcomes.map((o) => o.result)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(res.outcomes[2]?.reason).toContain('consistency');
    expect(res.writes).toEqual([]);
    expect(await vault.exists('10_Aufgaben/neu.md')).toBe(false);
  });

  it('bei exakt 50 % greift die Schwelle nicht — Einzelaktion-Skip', async () => {
    const vault = await seed({});
    const bad: Action = { type: 'note.create', path: 'Notizen/x.md', content: 'x' };
    const good: Action = { type: 'note.create', path: '10_Aufgaben/neu.md', content: 'x' };
    const res = await executeActions([bad, good], ctxOf([]), vault);
    expect(res.taskFailed).toBe(false);
    expect(res.outcomes.map((o) => o.result)).toEqual(['rejected', 'applied']);
    expect(await vault.exists('10_Aufgaben/neu.md')).toBe(true);
  });
});

describe('Guard-Property: bösartige Pfade werden nie geschrieben', () => {
  it('wendet für 500 generierte Escape-/Denylist-Pfade nie eine Aktion an', async () => {
    let s = 42;
    const rnd = (): number => {
      s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
      return s / 2_147_483_648;
    };
    const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)] as T;
    for (let i = 0; i < 500; i++) {
      const parts = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(['10_Aufgaben', 'sub', 'notes']));
      const mode = pick(['dotdot', 'dotseg', 'denyroot']);
      if (mode === 'dotdot') parts.splice(Math.floor(rnd() * (parts.length + 1)), 0, '..');
      else if (mode === 'dotseg') parts.splice(Math.floor(rnd() * (parts.length + 1)), 0, pick(['.obsidian', '.git', '.trash']));
      else parts.unshift(pick(['_crews', '_vaultrag']));
      const path = `${parts.join('/')}/evil.md`;
      const vault = await seed({});
      const res = await executeActions(
        [{ type: 'note.create', path, content: 'x' }],
        ctxOf([], { team: makeTeam({ writeScope: ['**/*.md'] }) }),
        vault,
      );
      expect(res.outcomes[0]?.result).toBe('rejected');
      expect(await vault.exists(path)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/core/action-executor.test.ts --reporter=basic
```

Erwartet: Fehlschlag beim Modul-Load — `Failed to resolve import "../../src/core/action-executor"` (bzw. `Cannot find module`), da die Implementierung noch fehlt.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/action-executor.ts
import type {
  Action, ActionOutcome, ActionsTaskDef, CollectedFile, RunLimits, SlugTableData, TeamDef,
} from './types';
import type { VaultPort } from './ports';
import { globMatch, isDenied, normalizeVaultPath } from './paths';
import { fnv1a } from './collectors';

export interface ExecutorContext {
  team: TeamDef;
  task: ActionsTaskDef;
  limits: RunLimits;
  writeCount: number;
  sources: CollectedFile[];
  /** Slug-Tabellen der Input-Artefakte (key = Frontmatter-Key); für byte-genaues Rück-Mapping. */
  slugTables: Record<string, SlugTableData>;
}

export const CREW_MARKER = (teamId: string): { start: string; end: string } => ({
  start: `<!-- crew:${teamId} -->`,
  end: `<!-- /crew:${teamId} -->`,
});

interface ValidatedAction {
  action: Action;
  path: string;
  outcome: ActionOutcome | null; // null = Validierung bestanden, wird in Phase 2 angewendet
  mappedSet: Record<string, string | number | null> | null; // rückgemappte Werte (frontmatter.patch)
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function outcomeOf(action: Action, result: 'rejected' | 'stale' | 'failed', reason: string): ActionOutcome {
  return { action, result, reason };
}

function findHeadingLine(lines: string[], heading: string): number {
  return lines.findIndex((l) => {
    const m = /^#{1,6}\s+(.*?)\s*$/.exec(l);
    return m !== null && m[1] === heading;
  });
}

async function validateAction(action: Action, ctx: ExecutorContext, vault: VaultPort): Promise<ValidatedAction> {
  const v: ValidatedAction = { action, path: '', outcome: null, mappedSet: null };

  // 1. Pfad-Normalisierung — '..' ist hart verboten
  try {
    v.path = normalizeVaultPath(action.path);
  } catch {
    v.outcome = outcomeOf(action, 'rejected', `Pfad enthält '..': ${action.path}`);
    return v;
  }
  // 2. Denylist überstimmt jede Whitelist
  if (isDenied(v.path)) {
    v.outcome = outcomeOf(action, 'rejected', `Pfad auf Denylist: ${v.path}`);
    return v;
  }
  // 3. write_scope-Whitelist des Teams
  if (!ctx.team.writeScope.some((g) => globMatch(g, v.path))) {
    v.outcome = outcomeOf(action, 'rejected', `Pfad außerhalb write_scope: ${v.path}`);
    return v;
  }
  // 4. Aktionstyp + typspezifische Checks
  if (!ctx.task.allowedActions.includes(action.type)) {
    v.outcome = outcomeOf(action, 'rejected', `Aktionstyp nicht in allowed_actions: ${action.type}`);
    return v;
  }
  if (action.type === 'frontmatter.patch') {
    const keys = [...Object.keys(action.set), ...action.remove];
    const allowed = ctx.task.allowedKeys ?? [];
    const badKey = keys.find((k) => !allowed.includes(k));
    if (badKey !== undefined) {
      v.outcome = outcomeOf(action, 'rejected', `Key nicht in allowed_keys: ${badKey}`);
      return v;
    }
    const mapped: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(action.set)) {
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
    if (!(await vault.exists(v.path))) {
      v.outcome = outcomeOf(action, 'failed', `Datei existiert nicht: ${v.path}`);
      return v;
    }
    v.mappedSet = mapped;
  } else if (action.type === 'note.create') {
    if (!v.path.endsWith('.md')) {
      v.outcome = outcomeOf(action, 'rejected', `nur .md-Dateien erlaubt: ${v.path}`);
      return v;
    }
    if (await vault.exists(v.path)) {
      v.outcome = outcomeOf(action, 'rejected', `existiert bereits — note.create überschreibt nie: ${v.path}`);
      return v;
    }
    if (byteLength(action.content) > ctx.limits.maxNoteBytes) {
      v.outcome = outcomeOf(action, 'rejected', `content überschreitet maxNoteBytes (${ctx.limits.maxNoteBytes})`);
      return v;
    }
  } else if (action.type === 'note.append') {
    if (!(await vault.exists(v.path))) {
      v.outcome = outcomeOf(action, 'failed', `Ziel existiert nicht: ${v.path} — zuerst anlegen`);
      return v;
    }
    if (byteLength(action.content) > ctx.limits.maxNoteBytes) {
      v.outcome = outcomeOf(action, 'rejected', `content überschreitet maxNoteBytes (${ctx.limits.maxNoteBytes})`);
      return v;
    }
    if (action.heading !== null) {
      const current = await vault.read(v.path);
      if (findHeadingLine(current.split('\n'), action.heading) === -1) {
        v.outcome = outcomeOf(action, 'failed', `Heading '${action.heading}' nicht gefunden in ${v.path}`);
        return v;
      }
    }
  } else {
    // section.replace
    if (!(await vault.exists(v.path))) {
      v.outcome = outcomeOf(action, 'failed', `Ziel existiert nicht: ${v.path} — zuerst anlegen (create_if_missing: false)`);
      return v;
    }
    if (byteLength(action.content) > ctx.limits.maxNoteBytes) {
      v.outcome = outcomeOf(action, 'rejected', `content überschreitet maxNoteBytes (${ctx.limits.maxNoteBytes})`);
      return v;
    }
  }
  // 5. Stale-Guard: nur wo die Datei im Quellmaterial liegt; note.create ausgenommen
  if (action.type !== 'note.create') {
    const src = ctx.sources.find((f) => f.path === v.path);
    if (src !== undefined) {
      const current = await vault.read(v.path);
      if (fnv1a(current) !== src.contentHash) {
        v.outcome = { action, result: 'stale', reason: `Datei seit Collect geändert: ${v.path}` };
        return v;
      }
    }
  }
  return v;
}

function appendContent(current: string, heading: string | null, content: string): string {
  const block = content.endsWith('\n') ? content : `${content}\n`;
  if (heading === null) {
    const base = current === '' || current.endsWith('\n') ? current : `${current}\n`;
    return base + block;
  }
  const lines = current.split('\n');
  const start = findHeadingLine(lines, heading);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > start + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;
  return [...lines.slice(0, insertAt), ...content.split('\n'), ...lines.slice(insertAt)].join('\n');
}

function replaceSection(current: string, teamId: string, content: string): string {
  const { start, end } = CREW_MARKER(teamId);
  const si = current.indexOf(start);
  const ei = current.indexOf(end);
  if (si === -1 && ei === -1) {
    const base = current === '' || current.endsWith('\n') ? current : `${current}\n`;
    return `${base}\n${start}\n${content}\n${end}\n`;
  }
  if (si === -1 || ei === -1 || ei < si) {
    throw new Error(`Crew-Marker beschädigt (start=${si}, end=${ei}) — Block manuell reparieren`);
  }
  return `${current.slice(0, si + start.length)}\n${content}\n${current.slice(ei)}`;
}

async function applyAction(v: ValidatedAction, ctx: ExecutorContext, vault: VaultPort): Promise<void> {
  const action = v.action;
  if (action.type === 'frontmatter.patch') {
    await vault.patchFrontmatter(v.path, v.mappedSet ?? {}, action.remove);
  } else if (action.type === 'note.create') {
    await vault.create(v.path, action.content);
  } else if (action.type === 'note.append') {
    const current = await vault.read(v.path);
    await vault.modify(v.path, appendContent(current, action.heading, action.content));
  } else {
    const current = await vault.read(v.path);
    await vault.modify(v.path, replaceSection(current, ctx.team.id, action.content));
  }
}

export async function executeActions(
  actions: Action[],
  ctx: ExecutorContext,
  vault: VaultPort,
): Promise<{ outcomes: ActionOutcome[]; writes: string[]; taskFailed: boolean }> {
  let taskFailed = false;

  // Phase 1: ALLE Aktionen validieren, bevor irgendetwas geschrieben wird.
  const validated: ValidatedAction[] = [];
  let budgetUsed = 0;
  for (const action of actions) {
    const v = await validateAction(action, ctx, vault);
    if (v.outcome === null) {
      // 6. Schreiblimit (writeCount aus dem Lauf + in diesem Task budgetierte Writes)
      if (ctx.writeCount + budgetUsed + 1 > ctx.team.maxWrites) {
        v.outcome = outcomeOf(action, 'rejected', `write_limit: max_writes (${ctx.team.maxWrites}) erreicht`);
        taskFailed = true;
      } else {
        budgetUsed += 1;
      }
    } else if (v.outcome.result === 'failed') {
      taskFailed = true;
    }
    validated.push(v);
  }

  // Konsistenz-Schwelle: > 50 % rejected/stale → Task-Fail, KEINE Aktion anwenden.
  const invalidCount = validated.filter(
    (v) => v.outcome !== null && (v.outcome.result === 'rejected' || v.outcome.result === 'stale'),
  ).length;
  if (actions.length > 0 && invalidCount * 2 > actions.length) {
    taskFailed = true;
    for (const v of validated) {
      if (v.outcome === null) {
        v.outcome = outcomeOf(v.action, 'rejected', 'consistency: > 50% der Aktionen rejected/stale — keine Aktion angewendet');
      }
    }
  }

  // Phase 2: anwenden.
  const outcomes: ActionOutcome[] = [];
  const writes: string[] = [];
  for (const v of validated) {
    if (v.outcome !== null) {
      outcomes.push(v.outcome);
      continue;
    }
    try {
      await applyAction(v, ctx, vault);
      if (!writes.includes(v.path)) writes.push(v.path);
      outcomes.push({ action: v.action, result: 'applied', reason: null });
    } catch (e) {
      taskFailed = true;
      outcomes.push(outcomeOf(v.action, 'failed', `io: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  return { outcomes, writes, taskFailed };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run tests/core/action-executor.test.ts --reporter=basic
```

Erwartet: alle Tests PASS (inkl. der 500 Property-Iterationen). Danach `npm run lint && npm run typecheck && npm test` — alles grün.

- [ ] **Step 5: Commit**

```
git add src/core/action-executor.ts tests/core/action-executor.test.ts
git commit -m "feat: two-phase action executor with guards, slug re-mapping, stale and consistency checks" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: GitPlanBuilder — purer Commit-Plan

**Files:**
- Create: `src/core/git-plan.ts`
- Test: `tests/core/git-plan.test.ts`

**Interfaces:**
- **Consumes** (aus Task 3): `RunState` aus `src/core/types.ts`; `CommitPlan { message: string; paths: string[] }` aus `src/core/ports.ts`.
- **Produces** (für Task 13 Orchestrator, Task 14 GitPort-Integrationstests):
  ```ts
  export function buildCommitPlan(state: RunState, runDir: string): CommitPlan;
  ```

**Semantik:** Erste Message-Zeile `crew(<teamId>): run <runId> — <status>, <n> Dateien` (n = deduplizierte `writeRegister`-Einträge). Body: Dateiliste (`- <pfad>`, dedupliziert, sortiert) gefolgt von `Run: <runDir>/run.md`. Danach Leerzeile und Trailer-Zeile `Crew-Run: <runId>`. `paths` = `writeRegister` + `runDir` als Verzeichnis-Pathspec, dedupliziert, sortiert — der Verzeichnis-Pathspec erfasst `run.md`, `state.json` **und** das nur im Fehlerfall existierende `artifacts/` (`git add -- <dir>` staged rekursiv), ohne dass der pure Builder das Dateisystem kennen muss (Spec §5.2: „registrierte Pfade + runs/<id>/**", nie `add -A`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/git-plan.test.ts
import { describe, expect, it } from 'vitest';
import type { RunState } from '../../src/core/types';
import { buildCommitPlan } from '../../src/core/git-plan';

const RUN_DIR = '_crews/runs/2026-07-02-0714-task-triage';

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: '2026-07-02-0714-task-triage', teamId: 'task-triage',
    teamPath: '_crews/teams/task-triage.md', status: 'ok',
    startedAt: 1_780_000_000_000, endedAt: 1_780_000_060_000,
    baseSha: 'aaa1111', commitSha: null, model: 'qwen/qwen3.6-35b-a3b', contextLength: 32_768,
    writeRegister: ['10_Aufgaben/b.md', '10_Aufgaben/a.md'], llmCalls: 2, tasks: [],
    errorTask: null, errorKind: null, ...overrides,
  };
}

describe('buildCommitPlan', () => {
  it('baut Message mit Kopfzeile, sortierter Dateiliste, Run-Verweis und Trailer', () => {
    const plan = buildCommitPlan(makeState(), RUN_DIR);
    expect(plan.message).toBe(
      [
        'crew(task-triage): run 2026-07-02-0714-task-triage — ok, 2 Dateien',
        '',
        '- 10_Aufgaben/a.md',
        '- 10_Aufgaben/b.md',
        'Run: _crews/runs/2026-07-02-0714-task-triage/run.md',
        '',
        'Crew-Run: 2026-07-02-0714-task-triage',
      ].join('\n'),
    );
  });

  it('paths = writeRegister + runDir, dedupliziert und sortiert', () => {
    const plan = buildCommitPlan(
      makeState({ writeRegister: ['10_Aufgaben/b.md', '10_Aufgaben/a.md', '10_Aufgaben/a.md'] }),
      RUN_DIR,
    );
    expect(plan.paths).toEqual(['10_Aufgaben/a.md', '10_Aufgaben/b.md', RUN_DIR]);
  });

  it('dedupliziert die Dateizahl in der Kopfzeile', () => {
    const plan = buildCommitPlan(
      makeState({ writeRegister: ['10_Aufgaben/a.md', '10_Aufgaben/a.md'] }),
      RUN_DIR,
    );
    expect(plan.message.split('\n')[0]).toBe('crew(task-triage): run 2026-07-02-0714-task-triage — ok, 1 Dateien');
  });

  it('null Writes → Protokoll-Commit ohne Dateiliste', () => {
    const plan = buildCommitPlan(makeState({ writeRegister: [] }), RUN_DIR);
    expect(plan.message).toBe(
      [
        'crew(task-triage): run 2026-07-02-0714-task-triage — ok, 0 Dateien',
        '',
        'Run: _crews/runs/2026-07-02-0714-task-triage/run.md',
        '',
        'Crew-Run: 2026-07-02-0714-task-triage',
      ].join('\n'),
    );
    expect(plan.paths).toEqual([RUN_DIR]);
  });

  it('trägt den finalen Status (partial/failed/aborted) in der Kopfzeile', () => {
    const plan = buildCommitPlan(makeState({ status: 'partial', errorTask: 'analyse', errorKind: 'invalid_output' }), RUN_DIR);
    expect(plan.message.split('\n')[0]).toBe('crew(task-triage): run 2026-07-02-0714-task-triage — partial, 2 Dateien');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/core/git-plan.test.ts --reporter=basic
```

Erwartet: `Failed to resolve import "../../src/core/git-plan"` (Modul existiert noch nicht).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/git-plan.ts
import type { CommitPlan } from './ports';
import type { RunState } from './types';

/**
 * Purer Commit-Plan-Builder (Spec §5.2): berechnet Message + exakte Pfadliste.
 * Der GitPort führt nur aus (`git add -- <paths>` — nie `add -A`).
 * runDir als Verzeichnis-Pathspec erfasst run.md, state.json und artifacts/.
 */
export function buildCommitPlan(state: RunState, runDir: string): CommitPlan {
  const files = [...new Set(state.writeRegister)].sort();
  const head = `crew(${state.teamId}): run ${state.runId} — ${state.status}, ${files.length} Dateien`;
  const bodyLines = [...files.map((f) => `- ${f}`), `Run: ${runDir}/run.md`];
  const message = `${head}\n\n${bodyLines.join('\n')}\n\nCrew-Run: ${state.runId}`;
  const paths = [...new Set([...state.writeRegister, runDir])].sort();
  return { message, paths };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run tests/core/git-plan.test.ts --reporter=basic
```

Erwartet: 5 Tests PASS. Danach `npm run lint && npm run typecheck && npm test` grün.

- [ ] **Step 5: Commit**

```
git add src/core/git-plan.ts tests/core/git-plan.test.ts
git commit -m "feat: pure git commit plan builder (message + exact path list)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: RunLogBuilder — run.md, state.json, ERROR_KINDS

**Files:**
- Create: `src/core/run-log.ts`
- Test: `tests/core/run-log.test.ts`

**Interfaces:**
- **Consumes** (aus Task 3): `RunState`, `TaskRecord`, `ActionOutcome`, `ErrorKind`, `Action` aus `src/core/types.ts`.
- **Produces** (für Task 13 Orchestrator, Task 17 Recovery, Task 19 Golden-Run):
  ```ts
  export function buildRunMd(state: RunState): string;
  export function buildStateJson(state: RunState): string;
  export const ERROR_KINDS: readonly ErrorKind[];
  ```

**Semantik:** Frontmatter exakt nach Spec §2.4 in der Reihenfolge `crew-kind: run`, `team`, `started`/`ended` (ISO-8601), `status`, `commit`, `writes`, `llm_calls`, `duration_s`, `model`, `error_task`, `error_kind` — Felder mit `null`-Wert werden weggelassen (Bases-tauglich, flach). Body: pro `TaskRecord` ein Abschnitt `## <taskId>` mit Status, Dauer, Modell, Prompt-Hash, Think-Tokens (null-/Null-Werte weggelassen), Fehlerzeile, Artefakt als ```json-Block, Outcomes-Liste mit Präfix `✓` (applied) / `✗` (failed) / `↷` (rejected) / `⊘` (stale) und Ein-Zeilen-reason. Abschlusszeile mit Commit-SHA + Undo-Hinweis (`Undo: git revert <sha>`), nur wenn `commitSha` gesetzt (run.md wird inkrementell auch mit `status: running` geschrieben). `buildStateJson` ist trivial `JSON.stringify(state, null, 2)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/run-log.test.ts
import { describe, expect, it } from 'vitest';
import type { Action, RunState, TaskRecord } from '../../src/core/types';
import { ERROR_KINDS, buildRunMd, buildStateJson } from '../../src/core/run-log';

const started = Date.parse('2026-07-02T05:14:00.000Z');

function rec(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 't', kind: 'collector', status: 'ok', startedAt: started, endedAt: started + 1000,
    model: null, promptHash: null, thinkTokens: 0, artifactJson: null, outcomes: [], error: null,
    ...overrides,
  };
}

const patchA: Action = { type: 'frontmatter.patch', path: '10_Aufgaben/a.md', set: { priority: 'mittel' }, remove: [] };
const patchB: Action = { type: 'frontmatter.patch', path: '10_Aufgaben/b.md', set: { priority: 'dringend' }, remove: [] };

const okState: RunState = {
  runId: '2026-07-02-0714-task-triage', teamId: 'task-triage',
  teamPath: '_crews/teams/task-triage.md', status: 'ok',
  startedAt: started, endedAt: started + 83_000, baseSha: 'aaa1111', commitSha: 'abc1234',
  model: 'qwen/qwen3.6-35b-a3b', contextLength: 32_768,
  writeRegister: ['10_Aufgaben/a.md', '10_Aufgaben/b.md'], llmCalls: 2,
  tasks: [
    rec({ taskId: 'collect', endedAt: started + 1200, artifactJson: { count: 2 } }),
    rec({
      taskId: 'analyse', kind: 'llm', endedAt: started + 41_600,
      model: 'qwen/qwen3.6-35b-a3b', promptHash: 'f00dbabe', thinkTokens: 340,
      artifactJson: { items: [{ path: '10_Aufgaben/a.md' }] },
    }),
    rec({
      taskId: 'apply', kind: 'actions', endedAt: started + 400,
      outcomes: [
        { action: patchA, result: 'applied', reason: null },
        { action: patchB, result: 'rejected', reason: "Wert 'dringend' für 'priority' nicht in enumerierter Wertemenge" },
      ],
    }),
  ],
  errorTask: null, errorKind: null,
};

describe('buildRunMd', () => {
  it('rendert einen ok-Lauf byte-genau (Golden)', () => {
    const expected = [
      '---',
      'crew-kind: run',
      'team: task-triage',
      'started: 2026-07-02T05:14:00.000Z',
      'ended: 2026-07-02T05:15:23.000Z',
      'status: ok',
      'commit: abc1234',
      'writes: 2',
      'llm_calls: 2',
      'duration_s: 83',
      'model: qwen/qwen3.6-35b-a3b',
      '---',
      '',
      '# Run 2026-07-02-0714-task-triage',
      '',
      '## collect',
      '',
      '- Status: ok',
      '- Dauer: 1.2 s',
      '',
      '```json',
      '{',
      '  "count": 2',
      '}',
      '```',
      '',
      '## analyse',
      '',
      '- Status: ok',
      '- Dauer: 41.6 s',
      '- Modell: qwen/qwen3.6-35b-a3b',
      '- Prompt-Hash: f00dbabe',
      '- Think-Tokens: 340',
      '',
      '```json',
      '{',
      '  "items": [',
      '    {',
      '      "path": "10_Aufgaben/a.md"',
      '    }',
      '  ]',
      '}',
      '```',
      '',
      '## apply',
      '',
      '- Status: ok',
      '- Dauer: 0.4 s',
      '',
      '- ✓ frontmatter.patch 10_Aufgaben/a.md',
      "- ↷ frontmatter.patch 10_Aufgaben/b.md — Wert 'dringend' für 'priority' nicht in enumerierter Wertemenge",
      '',
      'Commit: abc1234 — Undo: git revert abc1234',
    ].join('\n') + '\n';
    expect(buildRunMd(okState)).toBe(expected);
  });

  it('läuft inkrementell: running-Zustand lässt null-Felder und Undo-Zeile weg', () => {
    const md = buildRunMd({ ...okState, status: 'running', endedAt: null, commitSha: null, tasks: [] });
    expect(md).toContain('status: running');
    expect(md).not.toContain('ended:');
    expect(md).not.toContain('commit:');
    expect(md).not.toContain('duration_s:');
    expect(md).not.toContain('Undo:');
  });

  it('failed-Lauf trägt error_task/error_kind und Ein-Zeilen-Fehler im Task-Abschnitt', () => {
    const md = buildRunMd({
      ...okState, status: 'failed', errorTask: 'analyse', errorKind: 'invalid_output',
      tasks: [rec({
        taskId: 'analyse', kind: 'llm', status: 'failed',
        error: { kind: 'invalid_output', message: 'JSON nicht extrahierbar\nRohtext in artifacts/' },
      })],
    });
    expect(md).toContain('error_task: analyse');
    expect(md).toContain('error_kind: invalid_output');
    expect(md).toContain('- Fehler (invalid_output): JSON nicht extrahierbar');
    expect(md).not.toContain('Rohtext in artifacts/');
  });

  it('markiert failed/stale Outcomes mit ✗/⊘', () => {
    const md = buildRunMd({
      ...okState,
      tasks: [rec({
        taskId: 'apply', kind: 'actions',
        outcomes: [
          { action: patchA, result: 'failed', reason: 'io: kaputt' },
          { action: patchB, result: 'stale', reason: 'Datei seit Collect geändert: 10_Aufgaben/b.md' },
        ],
      })],
    });
    expect(md).toContain('- ✗ frontmatter.patch 10_Aufgaben/a.md — io: kaputt');
    expect(md).toContain('- ⊘ frontmatter.patch 10_Aufgaben/b.md — Datei seit Collect geändert: 10_Aufgaben/b.md');
  });
});

describe('buildStateJson', () => {
  it('serialisiert den RunState verlustfrei (pretty JSON)', () => {
    const json = buildStateJson(okState);
    expect(json).toBe(JSON.stringify(okState, null, 2));
    expect(JSON.parse(json)).toEqual(okState);
  });
});

describe('ERROR_KINDS', () => {
  it('enthält alle 12 typisierten Fehlerklassen', () => {
    expect(ERROR_KINDS).toHaveLength(12);
    for (const k of ['endpoint_unreachable', 'model_missing', 'timeout', 'stalled', 'invalid_output',
      'context_overflow', 'git_refused', 'crew_invalid', 'write_limit', 'consistency', 'aborted', 'io']) {
      expect(ERROR_KINDS).toContain(k);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/core/run-log.test.ts --reporter=basic
```

Erwartet: `Failed to resolve import "../../src/core/run-log"` (Modul existiert noch nicht).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/run-log.ts
import type { ActionOutcome, ErrorKind, RunState, TaskRecord } from './types';

export const ERROR_KINDS: readonly ErrorKind[] = [
  'endpoint_unreachable', 'model_missing', 'timeout', 'stalled',
  'invalid_output', 'context_overflow', 'git_refused', 'crew_invalid',
  'write_limit', 'consistency', 'aborted', 'io',
];

const OUTCOME_PREFIX: Record<ActionOutcome['result'], string> = {
  applied: '✓', failed: '✗', rejected: '↷', stale: '⊘',
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? '';
}

function frontmatterLines(state: RunState): string[] {
  const lines: string[] = ['crew-kind: run', `team: ${state.teamId}`, `started: ${iso(state.startedAt)}`];
  if (state.endedAt !== null) lines.push(`ended: ${iso(state.endedAt)}`);
  lines.push(`status: ${state.status}`);
  if (state.commitSha !== null) lines.push(`commit: ${state.commitSha}`);
  lines.push(`writes: ${state.writeRegister.length}`, `llm_calls: ${state.llmCalls}`);
  if (state.endedAt !== null) lines.push(`duration_s: ${Math.round((state.endedAt - state.startedAt) / 1000)}`);
  lines.push(`model: ${state.model}`);
  if (state.errorTask !== null) lines.push(`error_task: ${state.errorTask}`);
  if (state.errorKind !== null) lines.push(`error_kind: ${state.errorKind}`);
  return lines;
}

function outcomeLine(o: ActionOutcome): string {
  const base = `- ${OUTCOME_PREFIX[o.result]} ${o.action.type} ${o.action.path}`;
  return o.reason === null ? base : `${base} — ${firstLine(o.reason)}`;
}

function taskSection(rec: TaskRecord): string[] {
  const lines: string[] = [`## ${rec.taskId}`, '', `- Status: ${rec.status}`, `- Dauer: ${((rec.endedAt - rec.startedAt) / 1000).toFixed(1)} s`];
  if (rec.model !== null) lines.push(`- Modell: ${rec.model}`);
  if (rec.promptHash !== null) lines.push(`- Prompt-Hash: ${rec.promptHash}`);
  if (rec.thinkTokens > 0) lines.push(`- Think-Tokens: ${rec.thinkTokens}`);
  if (rec.error !== null) lines.push(`- Fehler (${rec.error.kind}): ${firstLine(rec.error.message)}`);
  if (rec.artifactJson !== null && rec.artifactJson !== undefined) {
    lines.push('', '```json', JSON.stringify(rec.artifactJson, null, 2), '```');
  }
  if (rec.outcomes.length > 0) lines.push('', ...rec.outcomes.map(outcomeLine));
  return lines;
}

export function buildRunMd(state: RunState): string {
  const parts: string[] = ['---', ...frontmatterLines(state), '---', '', `# Run ${state.runId}`];
  for (const rec of state.tasks) parts.push('', ...taskSection(rec));
  if (state.commitSha !== null) parts.push('', `Commit: ${state.commitSha} — Undo: git revert ${state.commitSha}`);
  return `${parts.join('\n')}\n`;
}

export function buildStateJson(state: RunState): string {
  return JSON.stringify(state, null, 2);
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run tests/core/run-log.test.ts --reporter=basic
```

Erwartet: alle Tests PASS (inkl. Golden-Vergleich byte-genau). Danach `npm run lint && npm run typecheck && npm test` grün.

- [ ] **Step 5: Commit**

```
git add src/core/run-log.ts tests/core/run-log.test.ts
git commit -m "feat: run log builder (run.md frontmatter+body, state.json, typed error kinds)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```