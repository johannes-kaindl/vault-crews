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
