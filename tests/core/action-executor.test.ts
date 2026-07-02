// tests/core/action-executor.test.ts
import { describe, expect, it } from 'vitest';
import type { Action, ActionsTaskDef, CollectedFile, RunLimits, TeamDef } from '../../src/core/types';
import type { VaultPort } from '../../src/core/ports';
import { CREW_MARKER, executeActions, type ExecutorContext } from '../../src/core/action-executor';
import { fnv1a } from '../../src/core/collectors';
import { buildDenylist } from '../../src/core/paths';
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
    denylist: buildDenylist('.obsidian'),
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
