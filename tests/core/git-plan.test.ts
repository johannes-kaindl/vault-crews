import { describe, expect, it } from 'vitest';
import type { RunState } from '../../src/core/types';
import { buildCommitPlan } from '../../src/core/git-plan';

const RUN_DIR = '_crews/runs/2026-07-02-0714-task-triage';

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: '2026-07-02-0714-task-triage', teamId: 'task-triage',
    teamPath: '_crews/teams/task-triage.md', status: 'ok',
    startedAt: 1_780_000_000_000, endedAt: 1_780_000_060_000,
    model: 'qwen/qwen3.6-35b-a3b', contextLength: 32_768,
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
