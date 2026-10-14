import type { App } from "obsidian";

export type RevealResult = "revealed" | "hidden" | "missing" | "no-explorer";

/** Zeigt den Crew-Ordner im Datei-Explorer (Befehl „Show crew folder“). Nur die öffentliche Seite von Obsidian:
 *  der Explorer ist ein Leaf des Typs `file-explorer`, `revealInFolder` hängt an seiner View und wird per Formprüfung
 *  benutzt (ein Obsidian ohne die Methode oder ohne den Kern-Plugin „Files“ meldet `no-explorer`, nichts bricht).
 *  Ist der Ordner per Einstellung versteckt, zeigt der Explorer ihn nicht — das meldet `hidden`, statt ins Leere zu laufen. */
export function revealCrewFolder(app: App, crewRoot: string, hideCrewFolder: boolean): RevealResult {
  const path = crewRoot.trim().replace(/\/+$/, "");
  const folder = path === "" ? null : app.vault.getAbstractFileByPath(path);
  if (!folder || !("children" in folder)) return "missing";
  if (hideCrewFolder) return "hidden";
  const leaf = app.workspace.getLeavesOfType("file-explorer")[0];
  const view = leaf?.view as { revealInFolder?: (f: unknown) => void } | undefined;
  if (!leaf || typeof view?.revealInFolder !== "function") return "no-explorer";
  void app.workspace.revealLeaf(leaf);
  view.revealInFolder(folder);
  return "revealed";
}
