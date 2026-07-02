// Smoke-Tests der dünnen Adapter (Mock-Grenze = Port-Grenze): kein Deep-Mocking,
// nur „richtige Obsidian-API + normalisierter Pfad". Mock-Helfer werden aus der
// Mock-Datei selbst importiert — der vitest-Alias `obsidian` zeigt auf DIESELBE
// Datei, daher sind Klassen wie TFile modul-identisch (instanceof funktioniert).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeApp, TFile } from "../__mocks__/obsidian";
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
});
