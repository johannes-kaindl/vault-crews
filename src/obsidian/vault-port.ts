import { normalizePath, TFile, type App } from "obsidian";
import type { MetadataPort, VaultPort } from "../core/ports";

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
    if (await this.app.vault.adapter.exists(np)) return; // idempotent
    await this.app.vault.adapter.mkdir(np);
  }

  async patchFrontmatter(
    path: string,
    set: Record<string, string | number | null>,
    remove: string[],
  ): Promise<void> {
    const f = this.file(path);
    // processFrontMatter patcht nur den YAML-Block und lässt alle anderen Bytes
    // der Datei unangetastet (Spec §2.5: nie ganzes Frontmatter re-serialisieren).
    await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(set)) fm[key] = value; // set: auch null-Werte
      for (const key of remove) delete fm[key];                        // remove: Key verschwindet
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
    const prefix = normalizePath(folder);
    const paths = this.app.vault.getMarkdownFiles().map((f) => f.path);
    const filtered = prefix === "/" || prefix === ""
      ? paths
      : paths.filter((p) => p.startsWith(prefix + "/")); // "+ '/'" verhindert Präfix-Fallen (Foo vs Foo-Archiv)
    return filtered.sort(); // deterministische Reihenfolge (Determinismus-Zusage §6.3)
  }

  async getFrontmatter(path: string): Promise<Record<string, unknown> | null> {
    const f = this.file(path);
    if (!f) return null;
    const cache = this.app.metadataCache.getFileCache(f);
    // Rohes Cache-Objekt durchreichen — Normalisierung/Kopie macht der Collector (core).
    return cache?.frontmatter ?? null;
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
