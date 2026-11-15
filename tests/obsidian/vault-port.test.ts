// Smoke-Tests der dünnen Adapter (Mock-Grenze = Port-Grenze): kein Deep-Mocking,
// nur „richtige Obsidian-API + normalisierter Pfad". Mock-Helfer werden aus der
// Mock-Datei selbst importiert — der vitest-Alias `obsidian` zeigt auf DIESELBE
// Datei, daher sind Klassen wie TFile modul-identisch (instanceof funktioniert).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeApp, TFile, TFolder } from "../__mocks__/obsidian";
import { ObsidianMetadataPort, ObsidianVaultPort } from "../../src/obsidian/vault-port";

let app: ReturnType<typeof makeFakeApp>;
beforeEach(() => { app = makeFakeApp(); });

describe("ObsidianVaultPort", () => {
  it("read normalisiert den Pfad und liest über vault.read", async () => {
    const file = new TFile("notes/a.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    app.vault.read = vi.fn().mockResolvedValue("Inhalt");
    const port = new ObsidianVaultPort(app);
    expect(await port.read("notes//a.md")).toBe("Inhalt");
    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith("notes/a.md");
    expect(app.vault.read).toHaveBeenCalledWith(file);
  });

  it("read wirft, wenn die Datei fehlt", async () => {
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
    await expect(new ObsidianVaultPort(app).read("fehlt.md")).rejects.toThrow(/nicht gefunden/);
  });

  it("create wirft bei existierender Datei und legt sonst mit normalisiertem Pfad an", async () => {
    app.vault.adapter.exists = vi.fn().mockResolvedValue(true);
    await expect(new ObsidianVaultPort(app).create("a.md", "x")).rejects.toThrow(/existiert/);
    app.vault.adapter.exists = vi.fn().mockResolvedValue(false);
    app.vault.create = vi.fn().mockResolvedValue(undefined);
    await new ObsidianVaultPort(app).create("sub//a.md", "x");
    expect(app.vault.create).toHaveBeenCalledWith("sub/a.md", "x");
  });

  it("modify ersetzt den Inhalt über vault.modify", async () => {
    const file = new TFile("_crews/runs/r1/run.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    app.vault.modify = vi.fn().mockResolvedValue(undefined);
    await new ObsidianVaultPort(app).modify("_crews/runs/r1/run.md", "neu");
    expect(app.vault.modify).toHaveBeenCalledWith(file, "neu");
  });

  it("append hängt an bestehende Dateien an und legt fehlende neu an", async () => {
    const file = new TFile("log.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    app.vault.append = vi.fn().mockResolvedValue(undefined);
    const port = new ObsidianVaultPort(app);
    await port.append("log.md", "Zeile\n");
    expect(app.vault.append).toHaveBeenCalledWith(file, "Zeile\n");

    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
    app.vault.create = vi.fn().mockResolvedValue(undefined);
    await port.append("neu.md", "Zeile\n");
    expect(app.vault.create).toHaveBeenCalledWith("neu.md", "Zeile\n");
  });

  it("mkdir ist idempotent über adapter.exists/adapter.mkdir", async () => {
    app.vault.adapter.exists = vi.fn().mockResolvedValue(false);
    app.vault.adapter.mkdir = vi.fn().mockResolvedValue(undefined);
    await new ObsidianVaultPort(app).mkdir("_crews/runs//r1");
    expect(app.vault.adapter.mkdir).toHaveBeenCalledWith("_crews/runs/r1");

    app.vault.adapter.exists = vi.fn().mockResolvedValue(true);
    app.vault.adapter.mkdir = vi.fn();
    await new ObsidianVaultPort(app).mkdir("_crews/runs/r1");
    expect(app.vault.adapter.mkdir).not.toHaveBeenCalled();
  });

  it('mkdir legt fehlende Ancestor-Ordner rekursiv an (adapter.mkdir ist nicht rekursiv)', async () => {
    const existing = new Set<string>();
    app.vault.adapter.exists = vi.fn().mockImplementation((p: string) => Promise.resolve(existing.has(p)));
    const made: string[] = [];
    app.vault.adapter.mkdir = vi.fn().mockImplementation((p: string) => { made.push(p); existing.add(p); return Promise.resolve(); });
    await new ObsidianVaultPort(app).mkdir("Daily/2026//07");
    expect(made).toEqual(["Daily", "Daily/2026", "Daily/2026/07"]);
  });

  it("patchFrontmatter setzt und entfernt Keys via fileManager.processFrontMatter", async () => {
    const file = new TFile("10_Aufgaben/t1.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    const fm: Record<string, unknown> = { status: "1_backlog_📥", alt: "weg" };
    app.fileManager.processFrontMatter = vi.fn(
      async (_f: unknown, cb: (fm: Record<string, unknown>) => void) => { cb(fm); },
    );
    await new ObsidianVaultPort(app).patchFrontmatter(
      "10_Aufgaben/t1.md",
      { priority: "2_mittel_🟡", period: null },
      ["alt"],
    );
    expect(app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
    // set-Semantik: Keys gesetzt (auch null-Werte); remove-Semantik: Key gelöscht;
    // alles andere unangetastet (Original-Bytes-Erhalt macht processFrontMatter selbst):
    expect(fm).toEqual({ status: "1_backlog_📥", priority: "2_mittel_🟡", period: null });
  });
});

describe("ObsidianVaultPort — patchFrontmatter add", () => {
  // Die Vereinigung geschieht in processFrontMatter aus dem Stand, den Obsidian dort übergibt, nicht aus einem vorher gelesenen.
  // Exakter Vergleich ohne Normalisierung: "#tag" ist nicht "tag", "1" ist nicht 1, ein Text mit Komma bleibt ein Element.
  async function addTo(before: unknown, add: (string | number)[], more: { set?: Record<string, string | number | null>; remove?: string[] } = {}) {
    const file = new TFile("a.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    const fm: Record<string, unknown> = {};
    if (before !== undefined) fm.tags = before;
    app.fileManager.processFrontMatter = vi.fn(
      async (_f: unknown, cb: (fm: Record<string, unknown>) => void) => { cb(fm); },
    );
    await new ObsidianVaultPort(app).patchFrontmatter("a.md", more.set ?? {}, more.remove ?? [], { tags: add });
    return fm;
  }

  it.each([
    [["a", "b"], ["b", "c"], ["a", "b", "c"]],
    ["a", ["c"], ["a", "c"]],
    [null, ["c"], ["c"]],
    [undefined, ["c"], ["c"]],
    [["a"], ["a", "a"], ["a"]],
    [["a"], [], ["a"]],
    [["#a"], ["a"], ["#a", "a"]],
    [["1"], [1], ["1", 1]],
    ["a, b", ["b"], ["a, b", "b"]],
    [3, [4], [3, 4]],
  ])("add vereinigt %j mit %j zu %j", async (before, add, after) => {
    const fm = await addTo(before, add as (string | number)[]);
    expect(fm.tags).toEqual(after);
  });

  it("rührt ein anderes Feld nicht an und wendet set und remove neben add an", async () => {
    const fm = await addTo(["a"], ["b"], { set: { priority: "mittel" }, remove: ["alt"] });
    expect(fm).toEqual({ tags: ["a", "b"], priority: "mittel" });
  });

  it("wirft, statt einen Wert zu überschreiben, den es nicht als Liste lesen kann", async () => {
    await expect(addTo({ a: 1 }, ["x"])).rejects.toThrow(/tags/);
    await expect(addTo(true, ["x"])).rejects.toThrow(/tags/);
  });

  it("ohne add bleibt es beim bisherigen Verhalten (set ersetzt)", async () => {
    const file = new TFile("a.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    const fm: Record<string, unknown> = { tags: ["a"] };
    app.fileManager.processFrontMatter = vi.fn(async (_f: unknown, cb: (fm: Record<string, unknown>) => void) => { cb(fm); });
    await new ObsidianVaultPort(app).patchFrontmatter("a.md", { tags: ["b"] }, []);
    expect(fm.tags).toEqual(["b"]);
  });
});

describe("ObsidianMetadataPort", () => {
  it("listMarkdownFiles filtert rekursiv per Ordner-Präfix und sortiert deterministisch", async () => {
    app.vault.getMarkdownFiles = vi.fn().mockReturnValue([
      new TFile("Other/c.md"),
      new TFile("10_Aufgaben/sub/b.md"),
      new TFile("10_Aufgaben/a.md"),
      new TFile("10_Aufgaben-Archiv/x.md"), // Präfix-Falle: darf NICHT matchen
    ]);
    const port = new ObsidianMetadataPort(app);
    expect(await port.listMarkdownFiles("10_Aufgaben")).toEqual([
      "10_Aufgaben/a.md",
      "10_Aufgaben/sub/b.md",
    ]);
  });

  it("listMarkdownFiles: leerer Ordner und / sind die Wurzel, ein Ordner mit .. enthält nichts, Unicode-Normalform zählt nicht", async () => {
    app.vault.getMarkdownFiles = vi.fn().mockReturnValue([
      new TFile("b.md"),
      new TFile("A/a.md"),
      new TFile("Ü/u.md"), // Ü zusammengesetzt (U+00DC)
    ]);
    const port = new ObsidianMetadataPort(app);
    expect(await port.listMarkdownFiles("")).toEqual(["A/a.md", "b.md", "Ü/u.md"]);
    expect(await port.listMarkdownFiles("/")).toEqual(["A/a.md", "b.md", "Ü/u.md"]);
    expect(await port.listMarkdownFiles("A/../A")).toEqual([]);
    expect(await port.listMarkdownFiles("U\u0308")).toEqual(["Ü/u.md"]); // Ü zerlegt (U + U+0308)
  });

  it("getFrontmatter liefert den Cache-Eintrag oder null", async () => {
    const file = new TFile("a.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    app.metadataCache.getFileCache = vi.fn().mockReturnValue({ frontmatter: { title: "A" } });
    const port = new ObsidianMetadataPort(app);
    expect(await port.getFrontmatter("a.md")).toEqual({ title: "A" });

    app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);
    expect(await port.getFrontmatter("a.md")).toBeNull();

    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
    expect(await port.getFrontmatter("fehlt.md")).toBeNull();
  });

  it("getBody schneidet den Frontmatter-Block über frontmatterPosition ab", async () => {
    const raw = "---\ntitle: A\n---\nErste Zeile\n";
    const fmEnd = raw.indexOf("---", 3) + 3; // Offset hinter der schließenden ---
    const file = new TFile("a.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    app.vault.cachedRead = vi.fn().mockResolvedValue(raw);
    app.metadataCache.getFileCache = vi.fn().mockReturnValue({
      frontmatter: { title: "A" },
      frontmatterPosition: {
        start: { line: 0, col: 0, offset: 0 },
        end: { line: 2, col: 3, offset: fmEnd },
      },
    });
    expect(await new ObsidianMetadataPort(app).getBody("a.md")).toBe("Erste Zeile\n");
  });

  it("getBody liefert den Rohinhalt, wenn kein Frontmatter existiert", async () => {
    const file = new TFile("b.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    app.vault.cachedRead = vi.fn().mockResolvedValue("Nur Body\n");
    app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);
    expect(await new ObsidianMetadataPort(app).getBody("b.md")).toBe("Nur Body\n");
  });

  describe("listTags", () => {
    function noteWith(path: string, cache: unknown): TFile {
      const f = new TFile(path);
      cacheOf.set(f, cache);
      return f;
    }
    const cacheOf = new Map<TFile, unknown>();
    beforeEach(() => {
      cacheOf.clear();
      app.metadataCache.getFileCache = vi.fn((f: TFile) => cacheOf.get(f) ?? null);
    });

    it("zählt Tags aus dem Text (cache.tags) und dem Frontmatter, ohne #, je Notiz einmal", async () => {
      app.vault.getMarkdownFiles = vi.fn().mockReturnValue([
        noteWith("a.md", { tags: [{ tag: "#projekt/alpha" }, { tag: "#projekt/alpha" }, { tag: "#neu" }], frontmatter: { tags: ["alt", "#projekt/alpha"] } }),
        noteWith("b.md", { frontmatter: { tags: "alt, neu extra" } }),
        noteWith("c.md", null),
        noteWith("d.md", { frontmatter: { tags: [3, null, ""] } }),
      ]);
      const tags = await new ObsidianMetadataPort(app).listTags();
      expect(Object.fromEntries(tags.map((t) => [t.tag, t.count]))).toEqual({ "projekt/alpha": 1, neu: 2, alt: 2, extra: 1 });
    });

    it("liefert [] für einen Vault ohne Tags", async () => {
      app.vault.getMarkdownFiles = vi.fn().mockReturnValue([noteWith("a.md", {})]);
      expect(await new ObsidianMetadataPort(app).listTags()).toEqual([]);
    });
  });

  describe("recentNoteNames", () => {
    function noteAt(path: string, mtime: number): TFile {
      const f = new TFile(path);
      f.stat.mtime = mtime;
      return f;
    }

    it("liefert die Dateinamen ohne .md, zuletzt geänderte zuerst, mit Unterordnern, höchstens limit", async () => {
      app.vault.getMarkdownFiles = vi.fn().mockReturnValue([
        noteAt("P/alt.md", 10), noteAt("P/sub/neu.md", 30), noteAt("P/mitte.md", 20),
        noteAt("P-Archiv/x.md", 99), noteAt("Q/y.md", 99),
      ]);
      const port = new ObsidianMetadataPort(app);
      expect(await port.recentNoteNames("P", 10)).toEqual(["neu", "mitte", "alt"]);
      expect(await port.recentNoteNames("P", 2)).toEqual(["neu", "mitte"]);
    });

    it("bei gleicher Änderungszeit entscheidet der Pfad; ein leerer Ordner ist die Wurzel", async () => {
      app.vault.getMarkdownFiles = vi.fn().mockReturnValue([noteAt("b.md", 5), noteAt("a.md", 5), noteAt("X/c.md", 1)]);
      expect(await new ObsidianMetadataPort(app).recentNoteNames("", 10)).toEqual(["a", "b", "c"]);
    });
  });
});

describe("ObsidianVaultPort — rename", () => {
  it("verschiebt über app.fileManager.renameFile mit normalisiertem Zielpfad", async () => {
    const file = new TFile("00_Inbox/a.md");
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    app.vault.adapter.exists = vi.fn().mockResolvedValue(false);
    app.fileManager.renameFile = vi.fn().mockResolvedValue(undefined);
    await new ObsidianVaultPort(app).rename("00_Inbox//a.md", "40_Projekte//Meyer/a.md");
    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith("00_Inbox/a.md");
    expect(app.fileManager.renameFile).toHaveBeenCalledTimes(1);
    expect(app.fileManager.renameFile).toHaveBeenCalledWith(file, "40_Projekte/Meyer/a.md");
  });

  it("wirft, wenn die Quelle fehlt, und rührt renameFile nicht an", async () => {
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
    app.fileManager.renameFile = vi.fn();
    await expect(new ObsidianVaultPort(app).rename("fehlt.md", "x/fehlt.md")).rejects.toThrow(/nicht gefunden/);
    expect(app.fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("wirft, wenn der Zielpfad belegt ist, statt Obsidian eine Nummer anhängen zu lassen", async () => {
    app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(new TFile("a.md"));
    app.vault.adapter.exists = vi.fn().mockResolvedValue(true);
    app.fileManager.renameFile = vi.fn();
    await expect(new ObsidianVaultPort(app).rename("a.md", "b/a.md")).rejects.toThrow(/existiert bereits/);
    expect(app.fileManager.renameFile).not.toHaveBeenCalled();
  });
});

describe("ObsidianMetadataPort — listFolders", () => {
  function folder(path: string, children: unknown[]): TFolder {
    const f = new TFolder(path);
    f.children = children;
    return f;
  }

  it("liefert die direkten Unterordner als Pfade, sortiert, ohne Dateien", async () => {
    const parent = folder("40_Projekte", [
      folder("40_Projekte/Zeta", [folder("40_Projekte/Zeta/Tief", [])]),
      new TFile("40_Projekte/lose.md"),
      folder("40_Projekte/Alpha", []),
    ]);
    app.vault.getFolderByPath = vi.fn().mockReturnValue(parent);
    expect(await new ObsidianMetadataPort(app).listFolders("40_Projekte/")).toEqual(["40_Projekte/Alpha", "40_Projekte/Zeta"]);
    expect(app.vault.getFolderByPath).toHaveBeenCalledWith("40_Projekte");
  });

  it("ein fehlender Ordner hat keine Unterordner", async () => {
    app.vault.getFolderByPath = vi.fn().mockReturnValue(null);
    expect(await new ObsidianMetadataPort(app).listFolders("Fehlt")).toEqual([]);
  });
});


describe("ObsidianVaultPort — linksFollowMoves", () => {
  const withConfig = (getConfig: unknown): ObsidianVaultPort => {
    (app.vault as unknown as Record<string, unknown>).getConfig = getConfig;
    return new ObsidianVaultPort(app);
  };

  it("liest alwaysUpdateLinks: false heißt false", () => {
    const getConfig = vi.fn().mockReturnValue(false);
    expect(withConfig(getConfig).linksFollowMoves()).toBe(false);
    expect(getConfig).toHaveBeenCalledWith("alwaysUpdateLinks");
  });

  it("true, undefined und jeder andere Wert heißen true (Obsidians Standard ist an)", () => {
    expect(withConfig(vi.fn().mockReturnValue(true)).linksFollowMoves()).toBe(true);
    expect(withConfig(vi.fn().mockReturnValue(undefined)).linksFollowMoves()).toBe(true);
    expect(withConfig(vi.fn().mockReturnValue(null)).linksFollowMoves()).toBe(true);
    expect(withConfig(vi.fn().mockReturnValue("false")).linksFollowMoves()).toBe(true);
  });

  it("fehlt getConfig oder wirft es, gilt true: eine fehlerhafte Lesung verhindert keinen Lauf", () => {
    expect(withConfig(undefined).linksFollowMoves()).toBe(true);
    expect(withConfig(() => { throw new Error("kaputt"); }).linksFollowMoves()).toBe(true);
  });
});
