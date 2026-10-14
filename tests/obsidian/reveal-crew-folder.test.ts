import { describe, expect, it, vi } from "vitest";
import { revealCrewFolder } from "../../src/obsidian/reveal-crew-folder";

function appWith(opts: { folder?: boolean; explorer?: "ok" | "keine-methode" | "kein-leaf" }) {
  const revealInFolder = vi.fn();
  const revealLeaf = vi.fn();
  const leaf = { view: opts.explorer === "keine-methode" ? {} : { revealInFolder } };
  const folderObj = { path: "_crews", children: [] };
  const app = {
    vault: { getAbstractFileByPath: (p: string) => (p === "_crews" ? (opts.folder === false ? { path: p, extension: "md" } : folderObj) : null) },
    workspace: { getLeavesOfType: (type: string) => (type === "file-explorer" && opts.explorer !== "kein-leaf" ? [leaf] : []), revealLeaf },
  };
  return { app: app as never, revealInFolder, revealLeaf, folderObj };
}

describe("revealCrewFolder (Befehl „Show crew folder“)", () => {
  it("zeigt den Ordner im Explorer und holt dessen Leaf nach vorn", () => {
    const { app, revealInFolder, revealLeaf, folderObj } = appWith({ explorer: "ok" });
    expect(revealCrewFolder(app, "_crews/", false)).toBe("revealed");
    expect(revealInFolder).toHaveBeenCalledWith(folderObj);
    expect(revealLeaf).toHaveBeenCalledTimes(1);
  });
  it("meldet missing, wenn der Pfad fehlt oder eine Datei ist", () => {
    expect(revealCrewFolder(appWith({ explorer: "ok" }).app, "gibt-es-nicht", false)).toBe("missing");
    expect(revealCrewFolder(appWith({ explorer: "ok", folder: false }).app, "_crews", false)).toBe("missing");
    expect(revealCrewFolder(appWith({ explorer: "ok" }).app, "  ", false)).toBe("missing");
  });
  it("meldet hidden statt ins Leere zu laufen, wenn der Ordner per Einstellung versteckt ist", () => {
    const { app, revealInFolder } = appWith({ explorer: "ok" });
    expect(revealCrewFolder(app, "_crews", true)).toBe("hidden");
    expect(revealInFolder).not.toHaveBeenCalled();
  });
  it("meldet no-explorer ohne Explorer-Leaf oder ohne revealInFolder", () => {
    expect(revealCrewFolder(appWith({ explorer: "kein-leaf" }).app, "_crews", false)).toBe("no-explorer");
    expect(revealCrewFolder(appWith({ explorer: "keine-methode" }).app, "_crews", false)).toBe("no-explorer");
  });
});
