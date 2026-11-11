import type { VaultPort } from "../core/ports";
import type { Lang } from "../vendor/kit/i18n";
import * as DE from "./example-assets";
import * as EN from "./example-assets-en";

/** Pfade (relativ zur Crew-Wurzel) und Inhalte der Beispiel-Crews je Sprache. Die Dateinamen
 *  tragen die Sprache der Vault-Oberfläche mit (`task-triage.md` / `notiz-tagger.md` …), damit
 *  der Crew-Name im Befehl und die Datei im Explorer zusammenpassen. */
function exampleAssets(lang: Lang): { path: string; content: string }[] {
  if (lang === "de") {
    return [
      { path: "agents/triage-analyst.md", content: DE.TRIAGE_ANALYST_AGENT },
      { path: "agents/briefing-autor.md", content: DE.BRIEFING_AUTOR_AGENT },
      { path: "teams/task-triage.md", content: DE.TASK_TRIAGE_TEAM },
      { path: "teams/daily-briefing.md", content: DE.DAILY_BRIEFING_TEAM },
      { path: "runs/runs.base", content: DE.RUNS_BASE },
      { path: "agents/notiz-tagger.md", content: DE.NOTIZ_TAGGER_AGENT },
      { path: "agents/reifegrad-tagger.md", content: DE.REIFEGRAD_TAGGER_AGENT },
      { path: "teams/notiz-tagger.md", content: DE.NOTIZ_TAGGER_TEAM },
      { path: "teams/reifegrad-tagger.md", content: DE.REIFEGRAD_TAGGER_TEAM },
    ];
  }
  return [
    { path: "agents/triage-analyst.md", content: EN.TRIAGE_ANALYST_AGENT },
    { path: "agents/briefing-author.md", content: EN.BRIEFING_AUTHOR_AGENT },
    { path: "teams/task-triage.md", content: EN.TASK_TRIAGE_TEAM },
    { path: "teams/daily-briefing.md", content: EN.DAILY_BRIEFING_TEAM },
    { path: "runs/runs.base", content: EN.RUNS_BASE },
    { path: "agents/note-tagger.md", content: EN.NOTE_TAGGER_AGENT },
    { path: "agents/maturity-tagger.md", content: EN.MATURITY_TAGGER_AGENT },
    { path: "teams/note-tagger.md", content: EN.NOTE_TAGGER_TEAM },
    { path: "teams/maturity-tagger.md", content: EN.MATURITY_TAGGER_TEAM },
  ];
}

/**
 * Installiert die vier mitgelieferten Beispiel-Crews (Task-Triage,
 * Daily-Briefing, Notiz-Tagger, Reifegrad-Tagger) + ihre Agenten + das
 * `runs.base`-Dashboard in `<root>/…`, in der Sprache der Oberfläche (`lang`).
 * Schreibt NUR Ziele, die noch nicht existieren (nie ein Overwrite — der Nutzer
 * editiert Beispiel-Crews nach der Installation frei, ein erneuter Aufruf des
 * Commands darf lokale Änderungen nie zurücksetzen). `root` ist der konfigurierte
 * Crew-Wurzelordner (Settings, Default `_crews`).
 */
export async function installExampleCrews(
  vault: VaultPort,
  root: string,
  lang: Lang,
): Promise<{ created: string[]; skipped: string[] }> {
  const base = root.replace(/\/+$/, "");
  await vault.mkdir(`${base}/agents`);
  await vault.mkdir(`${base}/teams`);
  await vault.mkdir(`${base}/runs`);

  const created: string[] = [];
  const skipped: string[] = [];
  for (const asset of exampleAssets(lang)) {
    const path = `${base}/${asset.path}`;
    if (await vault.exists(path)) {
      skipped.push(path);
      continue;
    }
    await vault.create(path, asset.content);
    created.push(path);
  }
  return { created, skipped };
}
