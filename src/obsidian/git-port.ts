/// <reference types="node" />
// Triple-slash opt-in to @types/node's ambient declarations (needed for `node:*`
// imports). Not file-scoped — brings ambient types into the entire program. Avoids
// editing tsconfig's global `types: []`. Consequence: src/core/** purity is enforced
// by `npm run check:pure` (grep) + convention, not the type system.
// Node-Builtins als STATISCHE top-level-Imports (NICHT dynamisches import()): esbuild
// schreibt einen externen statischen Import im cjs-Bundle zu require("node:…") um — das
// löst Obsidians Desktop-Renderer (nodeIntegration) auf, genau wie require("obsidian").
// Ein natives dynamisches import("node:child_process") behandelt der Renderer dagegen als
// Modul-URL-Fetch und BLOCKT es (CSP/CORS: "nur chrome/http/https/data") — das ließ im
// Smoke-Test jede git-Operation scheitern. Sicher, weil isDesktopOnly:true: das Plugin
// lädt nie dort, wo node fehlt. (vitest lädt statische node:-Imports nativ — Test bleibt gültig.)
import { execFile as execFileCb } from "node:child_process";
import { access, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Platform } from "obsidian";
import type { CommitPlan, GitPort, GitStatusInfo } from "../core/ports";

const execFileP = promisify(execFileCb);

/** Ausschnitt der Node-APIs, die dieser Port braucht — aus den top-level-Imports zusammengesetzt (siehe node()). */
interface NodeApis {
  execFile(file: string, args: string[], opts: { cwd: string; maxBuffer: number }): Promise<{ stdout: string; stderr: string }>;
  access(p: string): Promise<void>;
  writeFile(p: string, data: string, enc: "utf8"): Promise<void>;
  unlink(p: string): Promise<void>;
  join(...parts: string[]): string;
  isAbsolute(p: string): boolean;
}

const MAX_BUFFER = 10 * 1024 * 1024;
const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * GitPort über System-git via `child_process.execFile`.
 *
 * - `vaultRoot` = absoluter Dateisystem-Pfad der Vault-Wurzel. Wiring (Task 16):
 *   `new ChildProcessGitPort((this.app.vault.adapter as FileSystemAdapter).getBasePath())`.
 * - Node-Builtins (`child_process`, `util`, `fs/promises`, `path`) sind STATISCHE
 *   top-level-Imports (siehe Kommentar oben): esbuild macht daraus `require("node:…")`,
 *   das Obsidians Desktop-Renderer auflöst — ein natives `import("node:…")` würde vom
 *   Renderer als Modul-URL geblockt (Smoke-Test-Fund). `node:`-Präfix passend zur
 *   `external: ["obsidian", "electron", "node:*"]`-Wildcard. `node()` prüft weiterhin
 *   `Platform.isDesktop` und wirft dort einen klaren Fehler.
 * - Binary-Resolve (macOS-GUI-PATH-Problem): Aus Dock/Finder gestartete GUI-Apps erben
 *   NICHT die Shell-PATH (kein /opt/homebrew/bin, kein /usr/local/bin) — ein nacktes
 *   `execFile("git", …)` scheitert dort mit ENOENT, obwohl git im Terminal funktioniert.
 *   Deshalb wird zuerst der absolute Standardpfad `/usr/bin/git` probiert (auf macOS der
 *   immer vorhandene Xcode-CLT-Shim) und erst danach `git` über die PATH (Linux/Windows
 *   und abweichende Setups). Das Ergebnis wird pro Instanz gecacht.
 * - Der Port ist bewusst dumm: kein index.lock-Retry (macht der PREFLIGHT des
 *   Orchestrators), keine Commit-Inhalts-Logik (macht der pure GitPlanBuilder).
 */
export class ChildProcessGitPort implements GitPort {
  private apis: NodeApis | null = null;
  private gitBin: string | null = null;

  constructor(private readonly vaultRoot: string) {}

  private node(): NodeApis {
    if (this.apis) return this.apis;
    if (!Platform.isDesktop) {
      throw new Error("vault-crews: GitPort benötigt Desktop (child_process nicht verfügbar).");
    }
    this.apis = {
      execFile: (file, args, opts) => execFileP(file, args, opts),
      access: (p) => access(p),
      writeFile: (p, data, enc) => writeFile(p, data, enc),
      unlink: (p) => unlink(p),
      join: (...parts) => join(...parts),
      isAbsolute: (p) => isAbsolute(p),
    };
    return this.apis;
  }

  private async resolveGitBin(n: NodeApis): Promise<string> {
    if (this.gitBin) return this.gitBin;
    for (const candidate of ["/usr/bin/git", "git"]) {
      try {
        await n.execFile(candidate, ["--version"], { cwd: this.vaultRoot, maxBuffer: MAX_BUFFER });
        this.gitBin = candidate;
        return candidate;
      } catch {
        // Kandidat fehlt oder ist nicht ausführbar → nächsten probieren.
      }
    }
    throw new Error("vault-crews: git nicht gefunden (weder /usr/bin/git noch `git` in der PATH).");
  }

  /** Führt git im vaultRoot aus. Fehler tragen stderr in der Message (execFile-Verhalten). */
  private async git(args: string[]): Promise<string> {
    const n = this.node();
    const bin = await this.resolveGitBin(n);
    const { stdout } = await n.execFile(bin, args, { cwd: this.vaultRoot, maxBuffer: MAX_BUFFER });
    return stdout;
  }

  /** Absoluter Pfad des .git-Verzeichnisses (rev-parse liefert ihn relativ zum cwd). */
  private async gitDir(n: NodeApis): Promise<string> {
    const raw = (await this.git(["rev-parse", "--git-dir"])).trim();
    return n.isAbsolute(raw) ? raw : n.join(this.vaultRoot, raw);
  }

  private async fileExists(n: NodeApis, p: string): Promise<boolean> {
    try { await n.access(p); return true; } catch { return false; }
  }

  async status(): Promise<GitStatusInfo> {
    const n = this.node();
    let isRepo = false;
    try {
      isRepo = (await this.git(["rev-parse", "--is-inside-work-tree"])).trim() === "true";
    } catch {
      isRepo = false; // kein Repo (oder git defekt) → PREFLIGHT verweigert den Lauf
    }
    if (!isRepo) {
      return { isRepo: false, inMergeOrRebase: false, hasIndexLock: false, headSha: null, dirty: false };
    }

    const dir = await this.gitDir(n);
    const inMergeOrRebase =
      (await this.fileExists(n, n.join(dir, "MERGE_HEAD"))) ||
      (await this.fileExists(n, n.join(dir, "REBASE_HEAD")));
    const hasIndexLock = await this.fileExists(n, n.join(dir, "index.lock"));

    let headSha: string | null;
    try {
      headSha = (await this.git(["rev-parse", "HEAD"])).trim();
    } catch {
      headSha = null; // leeres Repo: HEAD existiert noch nicht
    }
    const dirty = (await this.git(["status", "--porcelain"])).trim().length > 0;
    return { isRepo, inMergeOrRebase, hasIndexLock, headSha, dirty };
  }

  async applyPlan(plan: CommitPlan): Promise<string> {
    if (plan.paths.length === 0) throw new Error("vault-crews: CommitPlan ohne Pfade.");
    const n = this.node();
    // Pfadgenaues Stagen — NIE `add -A`, der Dirty-State des Users bleibt unberührt (§5.2):
    await this.git(["add", "--", ...plan.paths]);
    // Message per -F aus .git/CREW_COMMIT_MSG: mehrzeiliger Body + `Crew-Run:`-Trailer bleiben
    // byte-genau; mehrere `-m` würden Absätze einziehen, stdin ist mit execFile umständlich.
    // Die Datei liegt IM .git-Verzeichnis (kann nie Teil eines Commits werden) und wird
    // anschließend gelöscht.
    const msgFile = n.join(await this.gitDir(n), "CREW_COMMIT_MSG");
    await n.writeFile(msgFile, plan.message, "utf8");
    try {
      await this.git(["commit", "-F", msgFile]);
    } finally {
      try { await n.unlink(msgFile); } catch { /* schon weg — egal */ }
    }
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async revert(sha: string): Promise<{ ok: boolean; conflictPaths: string[] }> {
    // `git revert` verlangt einen sauberen Working Tree. Während einer laufenden
    // Obsidian-Session ist der Tree praktisch immer dirty: (a) der Run-Log schreibt nach
    // dem Commit seine eigene commit-SHA in run.md/state.json zurück, (b) Obsidian schreibt
    // getrackte `.obsidian/*`-Configs dauernd neu. Ohne Vorbehandlung verweigert `revert`
    // VOR dem Start (kein Sequencer, 0 Konflikt-Pfade) — der alte Code deutete das als
    // 0-Datei-Konflikt und meldete irreführend „0 files have local changes" (Smoke-Fund).
    //
    // Strategie (§5.2: Dirty-State des Users nie verlieren):
    // 1. Dirt auf genau den Pfaden verwerfen, die der Revert ohnehin zurückdreht (v. a. die
    //    wegwerfbare Run-Log-SHA-Rückschreibung). Damit ist der Stash unten DISJUNKT zu dem,
    //    was der Revert anfasst → `stash pop` kann strukturell nie kollidieren.
    // 2. Den Rest stashen (fremder Dirt: `.obsidian`, andere Notizen), auf sauberem Tree
    //    revertieren, danach den Stash verlustfrei zurückspielen.
    // Echte Konflikte (committete Divergenz auf einem revertierten Pfad) erzeugt `revert`
    // weiterhin regulär → `collectConflictPaths` + Restore-Angebot greifen wie gehabt.
    const revertPaths = await this.pathsOf(sha);
    if (revertPaths.length > 0) {
      // `checkout -- <pfade>` ist auf sauberen Pfaden ein No-op; auf dirty Pfaden verwirft
      // es die uncommittete Änderung (die der Revert sowieso überschreibt).
      await this.git(["checkout", "--", ...revertPaths]);
    }
    const stashed = await this.stashDirtyState();
    try {
      try {
        await this.git(["revert", "--no-edit", sha]);
      } catch {
        // Konflikt-Pfade VOR dem Abort einsammeln — danach ist der Konfliktzustand weg.
        const conflictPaths = await this.collectConflictPaths();
        try {
          await this.git(["revert", "--abort"]);
        } catch {
          // Kein Sequencer-Zustand (z. B. unbekannte SHA) — nichts abzubrechen.
        }
        return { ok: false, conflictPaths };
      }
      return { ok: true, conflictPaths: [] };
    } finally {
      // Stash ist disjunkt zum Revert (Schritt 1) → pop ist im ok- wie im Konflikt-Fall
      // (nach `revert --abort`) konfliktfrei.
      if (stashed) await this.git(["stash", "pop"]);
    }
  }

  /** Von einem Commit berührte Pfade (add/modify/delete), relativ zur Vault-Wurzel. */
  private async pathsOf(sha: string): Promise<string[]> {
    // `--format=` unterdrückt Commit-Header → nur die Datei-Namen (eine führende Leerzeile).
    const out = await this.git(["show", "--name-only", "--format=", sha]);
    return out.split("\n").filter((line) => line.length > 0);
  }

  /** Stasht Working Tree + Index + Untracked, falls dirty. True, wenn ein Stash entstand. */
  private async stashDirtyState(): Promise<boolean> {
    const dirty = (await this.git(["status", "--porcelain"])).trim().length > 0;
    if (!dirty) return false;
    await this.git(["stash", "push", "--include-untracked", "-m", "vault-crews-undo"]);
    return true;
  }

  /** Unmerged-Einträge aus `git status --porcelain` (XY ∈ DD/AU/UD/UA/DU/AA/UU). */
  private async collectConflictPaths(): Promise<string[]> {
    const out = await this.git(["status", "--porcelain"]);
    const paths: string[] = [];
    for (const line of out.split("\n")) {
      if (line.length >= 4 && UNMERGED_XY.has(line.slice(0, 2))) paths.push(line.slice(3));
    }
    return paths.sort();
  }

  async restorePaths(sha: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    // `git restore --source=<sha>` statt `git checkout <sha> -- <paths>`: checkout schreibt
    // die Blobs zusätzlich in den Index (hinterlässt staged Changes) — restore berührt per
    // Default nur den Working Tree. Genau die gewünschte Semantik für den Datei-Fallback
    // nach einem Revert-Konflikt (§5.3), ohne Index-Nebenwirkung.
    await this.git(["restore", `--source=${sha}`, "--", ...paths]);
  }
}
