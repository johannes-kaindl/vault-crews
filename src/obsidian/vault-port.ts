import { normalizePath, TFile, type App } from "obsidian";
import { pathsInFolder } from "../vendor/kit/folder-scope";
import type { MetadataPort, VaultPort } from "../core/ports";
import type { FmValue } from "../core/types";

/**
 * Dünner VaultPort-Adapter über app.vault / app.fileManager.
 * Jede Methode delegiert 1:1; alle Pfade laufen durch normalizePath.
 * Guards/Limits/Denylist leben NICHT hier, sondern im puren ActionExecutor.
 */
export class ObsidianVaultPort implements VaultPort {
  constructor(private readonly app: App) {}

  private file(path: string): TFile {
    const np = normalizePath(path);
    const f = this.app.vault.getAbstractFileByPath(np);
    if (!(f instanceof TFile)) throw new Error(`vault-crews: Datei nicht gefunden: ${np}`);
    return f;
  }

  async read(path: string): Promise<string> {
    return this.app.vault.read(this.file(path));
  }

  async create(path: string, content: string): Promise<void> {
    const np = normalizePath(path);
    if (await this.exists(np)) throw new Error(`vault-crews: Datei existiert bereits: ${np}`);
    await this.app.vault.create(np, content);
  }

  async modify(path: string, content: string): Promise<void> {
    await this.app.vault.modify(this.file(path), content);
  }

  async append(path: string, content: string): Promise<void> {
    const np = normalizePath(path);
    const f = this.app.vault.getAbstractFileByPath(np);
    if (f instanceof TFile) await this.app.vault.append(f, content);
    else await this.app.vault.create(np, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizePath(path));
  }

  async mkdir(path: string): Promise<void> {
    const np = normalizePath(path);
    if (np === "" || (await this.app.vault.adapter.exists(np))) return; // idempotent
    const lastSlashIndex = np.lastIndexOf("/");
    if (lastSlashIndex > 0) {
      const parent = np.slice(0, lastSlashIndex);
      await this.mkdir(parent); // adapter.mkdir ist nicht rekursiv
    }
    await this.app.vault.adapter.mkdir(np);
  }

  async patchFrontmatter(
    path: string,
    set: Record<string, FmValue>,
    remove: string[],
    add?: Record<string, (string | number)[]>,
  ): Promise<void> {
    const f = this.file(path);
    // processFrontMatter patcht nur den YAML-Block und lässt alle anderen Bytes
    // der Datei unangetastet (Spec §2.5: nie ganzes Frontmatter re-serialisieren).
    await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(set)) fm[key] = value; // set: auch null-Werte
      for (const key of remove) delete fm[key];                        // remove: Key verschwindet
      // add: Vereinigung aus dem Stand, den Obsidian HIER übergibt (nicht aus einem vorher gelesenen), exakt und ohne Normalisierung.
      for (const [key, values] of Object.entries(add ?? {})) {
        const before = fm[key];
        let merged: unknown[];
        if (before === undefined || before === null) merged = [];
        else if (Array.isArray(before)) merged = [...(before as unknown[])];
        else if (typeof before === "string" || typeof before === "number") merged = [before];
        else throw new Error(`vault-crews: Feld '${key}' ist weder Liste noch Text noch Zahl, nichts hinzugefügt`);
        for (const v of values) if (!merged.includes(v)) merged.push(v);
        fm[key] = merged;
      }
    });
  }

  async trash(path: string): Promise<void> {
    const f = this.file(path); // wirft, wenn nicht vorhanden — Aufrufer prüft vorher via exists()
    // trashFile respektiert die Papierkorb-Einstellung des Users (System/.trash/lokal).
    await this.app.fileManager.trashFile(f);
  }
}

/** Dünner MetadataPort-Adapter über metadataCache + vault.getMarkdownFiles/cachedRead. */
export class ObsidianMetadataPort implements MetadataPort {
  constructor(private readonly app: App) {}

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  }

  async listMarkdownFiles(folder: string): Promise<string[]> {
    // Kit `folder-scope`: ganze Segmente (Foo vs Foo-Archiv), Unicode-NFC, UTF-16-Sortierung (Determinismus-Zusage §6.3).
    // Ein leerer Ordner (und `/`) heißt hier die Vault-Wurzel: `root: true`, weil ein Crew-Collector ohne `folder` alles sammelt.
    return pathsInFolder(this.app.vault.getMarkdownFiles().map((f) => f.path), folder.trim(), { root: true });
  }

  async getFrontmatter(path: string): Promise<Record<string, unknown> | null> {
    const f = this.file(path);
    if (!f) return null;
    const cache = this.app.metadataCache.getFileCache(f);
    // Rohes Cache-Objekt durchreichen — Normalisierung/Kopie macht der Collector (core).
    return cache?.frontmatter ?? null;
  }

  /** Tags aus `cache.tags` (im Text) und `cache.frontmatter.tags` (Liste oder Text mit Komma/Leerraum), ohne `#`, je Notiz einmal.
   *  Bewusst ohne `getAllTags` (Modulfunktion, im Test-Mock nicht vorhanden) und ohne Änderung der Schreibweise. */
  async listTags(): Promise<{ tag: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(f);
      const own = new Set<string>();
      for (const t of cache?.tags ?? []) own.add(t.tag.replace(/^#/, ""));
      const fmTags: unknown = cache?.frontmatter?.tags;
      const raw: unknown[] = Array.isArray(fmTags) ? fmTags : typeof fmTags === "string" ? fmTags.split(/[,\s]+/) : [];
      for (const t of raw) if (typeof t === "string" && t.replace(/^#/, "") !== "") own.add(t.replace(/^#/, ""));
      own.delete("");
      for (const t of own) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts].map(([tag, count]) => ({ tag, count }));
  }

  async recentNoteNames(folder: string, limit: number): Promise<string[]> {
    const files = this.app.vault.getMarkdownFiles();
    const inFolder = new Set(pathsInFolder(files.map((f) => f.path), folder.trim(), { root: true }));
    return files
      .filter((f) => inFolder.has(f.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, Math.max(0, limit))
      .map((f) => f.basename);
  }

  async getBody(path: string): Promise<string> {
    const f = this.file(path);
    if (!f) throw new Error(`vault-crews: Datei nicht gefunden: ${normalizePath(path)}`);
    const raw = await this.app.vault.cachedRead(f);
    const pos = this.app.metadataCache.getFileCache(f)?.frontmatterPosition;
    if (!pos) return raw;
    // Alles nach dem End-Offset der schließenden `---`, plus den folgenden Zeilenumbruch:
    return raw.slice(pos.end.offset).replace(/^\r?\n/, "");
  }
}
