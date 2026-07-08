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
  startedAt: started, endedAt: started + 83_000,
  model: 'qwen/qwen3.6-35b-a3b', contextLength: 32_768, alwaysOnThinker: false,
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
      'undoable: true',
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
      'Rückgängig: über das Vault-Crews-Panel (Verlauf → Rückgängig).',
    ].join('\n') + '\n';
    expect(buildRunMd(okState)).toBe(expected);
  });

  it('läuft inkrementell: running-Zustand lässt null-Felder und Undo-Zeile weg', () => {
    const md = buildRunMd({ ...okState, status: 'running', endedAt: null, tasks: [] });
    expect(md).toContain('status: running');
    expect(md).not.toContain('ended:');
    expect(md).not.toContain('undoable:');
    expect(md).not.toContain('duration_s:');
    expect(md).not.toContain('Rückgängig:');
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

  it('schreibt always_on_thinker:true in die Frontmatter wenn gesetzt', () => {
    const state = { ...okState, alwaysOnThinker: true };
    expect(buildRunMd(state)).toContain('always_on_thinker: true');
  });

  it('lässt always_on_thinker weg wenn false', () => {
    const state = { ...okState, alwaysOnThinker: false };
    expect(buildRunMd(state)).not.toContain('always_on_thinker');
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
  it('enthält alle 11 typisierten Fehlerklassen', () => {
    expect(ERROR_KINDS).toHaveLength(11);
    for (const k of ['endpoint_unreachable', 'model_missing', 'timeout', 'stalled', 'invalid_output',
      'context_overflow', 'crew_invalid', 'write_limit', 'consistency', 'aborted', 'io']) {
      expect(ERROR_KINDS).toContain(k);
    }
  });
});
