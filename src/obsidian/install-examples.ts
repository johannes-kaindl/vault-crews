import type { VaultPort } from "../core/ports";
import {
  BRIEFING_AUTOR_AGENT,
  DAILY_BRIEFING_TEAM,
  NOTIZ_TAGGER_AGENT,
  NOTIZ_TAGGER_TEAM,
  REIFEGRAD_TAGGER_AGENT,
  REIFEGRAD_TAGGER_TEAM,
  RUNS_BASE,
  TASK_TRIAGE_TEAM,
  TRIAGE_ANALYST_AGENT,
} from "./example-assets";

/**
 * Installiert die beiden mitgelieferten Beispiel-Crews (Task-Triage,
 * Daily-Briefing) + ihre Agenten + das `runs.base`-Dashboard in `<root>/…`.
 * Schreibt NUR Ziele, die noch nicht existieren (nie ein Overwrite — der Nutzer
 * editiert Beispiel-Crews nach der Installation frei, ein erneuter Aufruf des
 * Commands darf lokale Änderungen nie zurücksetzen). `root` ist der konfigurierte
 * Crew-Wurzelordner (Settings, Default `_crews`).
 */
export async function installExampleCrews(
  vault: VaultPort,
  root: string,
): Promise<{ created: string[]; skipped: string[] }> {
  const base = root.replace(/\/+$/, "");
  await vault.mkdir(`${base}/agents`);
  await vault.mkdir(`${base}/teams`);
  await vault.mkdir(`${base}/runs`);

  const assets: { path: string; content: string }[] = [
    { path: `${base}/agents/triage-analyst.md`, content: TRIAGE_ANALYST_AGENT },
    { path: `${base}/agents/briefing-autor.md`, content: BRIEFING_AUTOR_AGENT },
    { path: `${base}/teams/task-triage.md`, content: TASK_TRIAGE_TEAM },
    { path: `${base}/teams/daily-briefing.md`, content: DAILY_BRIEFING_TEAM },
    { path: `${base}/runs/runs.base`, content: RUNS_BASE },
    { path: `${base}/agents/notiz-tagger.md`, content: NOTIZ_TAGGER_AGENT },
    { path: `${base}/agents/reifegrad-tagger.md`, content: REIFEGRAD_TAGGER_AGENT },
    { path: `${base}/teams/notiz-tagger.md`, content: NOTIZ_TAGGER_TEAM },
    { path: `${base}/teams/reifegrad-tagger.md`, content: REIFEGRAD_TAGGER_TEAM },
  ];

  const created: string[] = [];
  const skipped: string[] = [];
  for (const asset of assets) {
    if (await vault.exists(asset.path)) {
      skipped.push(asset.path);
      continue;
    }
    await vault.create(asset.path, asset.content);
    created.push(asset.path);
  }
  return { created, skipped };
}
