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
