### Task 14: ChildProcessGitPort — System-git via `execFile` + Integrationstests gegen echtes git

**Files:**
- Create: `src/obsidian/git-port.ts`
- Create: `tests/integration/git-port.test.ts`
- Create: `vitest.integration.config.ts`
- Modify: `vitest.config.ts` (Integrationstests aus dem Default-Testlauf ausschließen)
- Modify: `package.json` (npm-Skript `test:integration`)
- Modify: `esbuild.config.mjs` (Node-Builtins als `external`)
- Test: `tests/integration/git-port.test.ts` (läuft NUR über `npm run test:integration`)

**Interfaces:**
- Consumes (aus Task 3, `src/core/ports.ts`):
  ```ts
  export interface GitStatusInfo { isRepo: boolean; inMergeOrRebase: boolean; hasIndexLock: boolean; headSha: string | null; dirty: boolean; }
  export interface CommitPlan { message: string; paths: string[]; }
  export interface GitPort {
    status(): Promise<GitStatusInfo>;
    applyPlan(plan: CommitPlan): Promise<string>;              // Commit-SHA
    revert(sha: string): Promise<{ ok: boolean; conflictPaths: string[] }>;
    restorePaths(sha: string, paths: string[]): Promise<void>;
  }
  ```
- Produces (für Task 16, Wiring in `main.ts`):
  ```ts
  export class ChildProcessGitPort implements GitPort {
    constructor(vaultRoot: string);
    // Wiring: new ChildProcessGitPort((this.app.vault.adapter as FileSystemAdapter).getBasePath())
  }
  ```

Wichtige Verhaltensverträge dieses Tasks: Der Port ist **dumm** — er führt aus und berichtet. Er retried `index.lock` NICHT selbst (die 3 Retries à 2 s macht der Orchestrator-PREFLIGHT, Task 13) und entscheidet nichts über Commit-Inhalte (das macht der pure `GitPlanBuilder`, Task 10). Die Commit-Message geht per `-F` aus `.git/CREW_COMMIT_MSG` in den Commit (mehrzeiliger Body + `Crew-Run:`-Trailer bleiben byte-genau; mehrere `-m` würden Absatz-Formatierung einführen, stdin ist mit `execFile` umständlich); die Datei liegt bewusst **im** `.git`-Verzeichnis, kann also nie versehentlich Teil eines Commits werden, und wird nach dem Commit gelöscht.

- [ ] **Step 1: Write the failing test** — Integrationstest-Infrastruktur + vollständiger Test.

  `vitest.integration.config.ts` (neu — eigene Config, damit die Integrationstests einen eigenen Einstiegspunkt mit höherem Timeout haben und nie versehentlich in `npm test` laufen):

  ```ts
  import { defineConfig } from "vitest/config";
  import { fileURLToPath } from "node:url";

  // Integrationstests gegen ECHTES git in Temp-Verzeichnissen.
  // Bewusst NICHT Teil von `npm test` — Aufruf: `npm run test:integration`.
  export default defineConfig({
    test: {
      environment: "node",
      include: ["tests/integration/**/*.test.ts"],
      testTimeout: 30_000, // git-Subprozesse: großzügiges Limit für langsame CI-Runner
    },
    resolve: {
      alias: {
        // Gleicher Mock-Alias wie in vitest.config.ts (git-port.ts importiert Platform):
        obsidian: fileURLToPath(new URL("./tests/__mocks__/obsidian.ts", import.meta.url)),
      },
    },
  });
  ```

  `vitest.config.ts` — kompletter Zielinhalt (gegenüber dem Stand aus Task 1 kommen nur der `configDefaults`-Import und die `exclude`-Zeile hinzu; alles andere unverändert lassen):

  ```ts
  import { configDefaults, defineConfig } from "vitest/config";
  import { fileURLToPath } from "node:url";

  export default defineConfig({
    test: {
      environment: "node",
      globals: true,
      // Integrationstests (echtes git) laufen NICHT im Default-`npm test`,
      // sondern über `npm run test:integration` (vitest.integration.config.ts):
      exclude: [...configDefaults.exclude, "tests/integration/**"],
    },
    resolve: {
      alias: {
        // Mock-Alias gehoert in vitest, NIE in tsconfig.json (PROF-OBS-08):
        obsidian: fileURLToPath(new URL("./tests/__mocks__/obsidian.ts", import.meta.url)),
      },
    },
  });
  ```

  `package.json` — in `scripts` direkt nach `"test": "vitest run",` diese Zeile einfügen:

  ```json
  "test:integration": "vitest run --config vitest.integration.config.ts",
  ```

  `tests/integration/git-port.test.ts` (vollständig):

  ```ts
  // Integrationstests gegen ECHTES git in einem mkdtemp-Verzeichnis.
  // Läuft NICHT im Default-`npm test` (vitest.config.ts excludet tests/integration/**),
  // sondern über `npm run test:integration`.
  import { execFile as execFileCb } from "node:child_process";
  import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { promisify } from "node:util";
  import { afterEach, beforeEach, describe, expect, it } from "vitest";
  import type { CommitPlan } from "../../src/core/ports";
  import { ChildProcessGitPort } from "../../src/obsidian/git-port";

  const execFile = promisify(execFileCb);

  // Test-seitiger git-Helfer (PATH-git reicht: Tests laufen im Terminal/CI, nicht in einer GUI-App).
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFile("git", args, { cwd });
    return stdout.trim();
  }

  async function initRepo(dir: string): Promise<void> {
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.email", "crew@test.invalid");
    await git(dir, "config", "user.name", "Crew Integration Test");
    await git(dir, "config", "commit.gpgsign", "false");
  }

  async function commitAll(dir: string, msg: string): Promise<string> {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", msg);
    return git(dir, "rev-parse", "HEAD");
  }

  const fileExists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

  let root = "";
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vault-crews-git-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  describe("ChildProcessGitPort.status", () => {
    it("meldet isRepo=false außerhalb eines Repos", async () => {
      const s = await new ChildProcessGitPort(root).status();
      expect(s).toEqual({ isRepo: false, inMergeOrRebase: false, hasIndexLock: false, headSha: null, dirty: false });
    });

    it("meldet headSha=null im leeren Repo (init ohne Commit)", async () => {
      await initRepo(root);
      const s = await new ChildProcessGitPort(root).status();
      expect(s.isRepo).toBe(true);
      expect(s.headSha).toBeNull();
      expect(s.dirty).toBe(false);
    });

    it("meldet headSha und dirty bei ungetrackter Datei", async () => {
      await initRepo(root);
      await writeFile(join(root, "a.md"), "A\n", "utf8");
      const sha = await commitAll(root, "c0");
      await writeFile(join(root, "untracked.md"), "X\n", "utf8");
      const s = await new ChildProcessGitPort(root).status();
      expect(s.headSha).toBe(sha);
      expect(s.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(s.dirty).toBe(true);
    });

    it("erkennt MERGE_HEAD und REBASE_HEAD als inMergeOrRebase", async () => {
      await initRepo(root);
      await writeFile(join(root, "a.md"), "A\n", "utf8");
      await commitAll(root, "c0");
      await writeFile(join(root, ".git", "MERGE_HEAD"), "deadbeef\n", "utf8");
      expect((await new ChildProcessGitPort(root).status()).inMergeOrRebase).toBe(true);
      await rm(join(root, ".git", "MERGE_HEAD"));
      await writeFile(join(root, ".git", "REBASE_HEAD"), "deadbeef\n", "utf8");
      expect((await new ChildProcessGitPort(root).status()).inMergeOrRebase).toBe(true);
    });

    it("erkennt index.lock als hasIndexLock", async () => {
      await initRepo(root);
      await writeFile(join(root, ".git", "index.lock"), "", "utf8");
      expect((await new ChildProcessGitPort(root).status()).hasIndexLock).toBe(true);
    });
  });

  describe("ChildProcessGitPort.applyPlan", () => {
    it("committet exakt die Plan-Pfade mit byte-genauer Message; Fremd-Dirty bleibt unberührt", async () => {
      await initRepo(root);
      await writeFile(join(root, "seed.md"), "seed\n", "utf8");
      await commitAll(root, "c0");
      await mkdir(join(root, "_crews/runs/r1"), { recursive: true });
      await writeFile(join(root, "note.md"), "Inhalt\n", "utf8");
      await writeFile(join(root, "_crews/runs/r1/run.md"), "log\n", "utf8");
      await writeFile(join(root, "user-dirty.md"), "nicht meins\n", "utf8");

      const plan: CommitPlan = {
        message:
          "crew(task-triage): run 2026-07-02-0714 — ok, 2 Dateien\n\n" +
          "- note.md\n- _crews/runs/r1/run.md\n\n" +
          "Crew-Run: 2026-07-02-0714-task-triage",
        paths: ["note.md", "_crews/runs/r1/run.md"],
      };
      const port = new ChildProcessGitPort(root);
      const sha = await port.applyPlan(plan);

      expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
      const files = (await git(root, "show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean).sort();
      expect(files).toEqual(["_crews/runs/r1/run.md", "note.md"]);
      // %B = roher Body; unser git()-Helfer trimmt nur trailing Newlines:
      expect(await git(root, "log", "-1", "--format=%B")).toBe(plan.message);
      // NIE `add -A`: die fremde Datei bleibt untracked liegen.
      expect(await git(root, "status", "--porcelain")).toBe("?? user-dirty.md");
      // Message-Datei wurde aufgeräumt:
      expect(await fileExists(join(root, ".git", "CREW_COMMIT_MSG"))).toBe(false);
    });

    it("wirft bei leerem CommitPlan", async () => {
      await initRepo(root);
      await expect(new ChildProcessGitPort(root).applyPlan({ message: "x", paths: [] }))
        .rejects.toThrow(/ohne Pfade/);
    });

    it("schlägt bei index.lock fehl und funktioniert nach Freigabe (index.lock-Szenario)", async () => {
      await initRepo(root);
      await writeFile(join(root, "seed.md"), "seed\n", "utf8");
      await commitAll(root, "c0");
      await writeFile(join(root, "note.md"), "Inhalt\n", "utf8");
      await writeFile(join(root, ".git", "index.lock"), "", "utf8");

      const port = new ChildProcessGitPort(root);
      expect((await port.status()).hasIndexLock).toBe(true);
      await expect(port.applyPlan({ message: "crew(t): run x — ok, 1 Dateien", paths: ["note.md"] }))
        .rejects.toThrow(/index\.lock/);

      await rm(join(root, ".git", "index.lock"));
      const sha = await port.applyPlan({ message: "crew(t): run x — ok, 1 Dateien", paths: ["note.md"] });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe("ChildProcessGitPort.revert", () => {
    it("revertiert einen Lauf-Commit sauber (ok=true)", async () => {
      await initRepo(root);
      await writeFile(join(root, "seed.md"), "seed\n", "utf8");
      await commitAll(root, "c0");
      await writeFile(join(root, "neu.md"), "vom Agenten\n", "utf8");
      const port = new ChildProcessGitPort(root);
      const runSha = await port.applyPlan({ message: "crew(t): run r — ok, 1 Dateien", paths: ["neu.md"] });

      const res = await port.revert(runSha);
      expect(res).toEqual({ ok: true, conflictPaths: [] });
      expect(await fileExists(join(root, "neu.md"))).toBe(false);
      expect(await git(root, "status", "--porcelain")).toBe(""); // Revert-Commit, kein loser Zustand
    });

    it("bricht bei Konflikt sauber ab und nennt die Konflikt-Pfade", async () => {
      await initRepo(root);
      await writeFile(join(root, "note.md"), "alpha\n", "utf8");
      await commitAll(root, "c0");
      const port = new ChildProcessGitPort(root);
      await writeFile(join(root, "note.md"), "beta\n", "utf8");
      const runSha = await port.applyPlan({ message: "crew(t): run r — ok, 1 Dateien", paths: ["note.md"] });
      await writeFile(join(root, "note.md"), "gamma\n", "utf8");
      const userSha = await commitAll(root, "user edit");

      const res = await port.revert(runSha);
      expect(res.ok).toBe(false);
      expect(res.conflictPaths).toEqual(["note.md"]);
      // `revert --abort` hat vollständig zurückgesetzt — niemals stiller Merge:
      expect(await git(root, "rev-parse", "HEAD")).toBe(userSha);
      expect(await git(root, "status", "--porcelain")).toBe("");
      expect(await readFile(join(root, "note.md"), "utf8")).toBe("gamma\n");
    });
  });

  describe("ChildProcessGitPort.restorePaths", () => {
    it("stellt einzelne Pfade aus einem älteren Stand in den Working Tree zurück (unstaged)", async () => {
      await initRepo(root);
      await writeFile(join(root, "note.md"), "beta\n", "utf8");
      await writeFile(join(root, "other.md"), "x\n", "utf8");
      const baseSha = await commitAll(root, "base");
      await writeFile(join(root, "note.md"), "gamma\n", "utf8");
      await writeFile(join(root, "other.md"), "y\n", "utf8");
      await commitAll(root, "edit");

      await new ChildProcessGitPort(root).restorePaths(baseSha, ["note.md"]);

      expect(await readFile(join(root, "note.md"), "utf8")).toBe("beta\n");
      expect(await readFile(join(root, "other.md"), "utf8")).toBe("y\n");      // nicht angefasst
      // `git restore --source` berührt nur den Working Tree — Index bleibt sauber:
      expect(await git(root, "status", "--porcelain")).toBe(" M note.md");
    });

    it("ist bei leerer Pfadliste ein No-op", async () => {
      await initRepo(root);
      await writeFile(join(root, "a.md"), "A\n", "utf8");
      await commitAll(root, "c0");
      await new ChildProcessGitPort(root).restorePaths("HEAD", []);
      expect(await git(root, "status", "--porcelain")).toBe("");
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```
  npx vitest run tests/integration/git-port.test.ts --config vitest.integration.config.ts --reporter=basic
  ```

  Erwarteter Fehler: `Failed to resolve import "../../src/obsidian/git-port" from "tests/integration/git-port.test.ts"` — das Modul existiert noch nicht.

- [ ] **Step 3: Write minimal implementation**

  `esbuild.config.mjs` — die `external`-Zeile erweitern (die Node-Builtins werden in `git-port.ts` dynamisch importiert; esbuild schreibt `import()` externer Module im cjs-Bundle zu `require()` um, das in Obsidians Electron-Renderer auf dem Desktop verfügbar ist):

  ```js
  // alt:
  external: ["obsidian", "electron"],
  // neu:
  external: ["obsidian", "electron", "child_process", "fs/promises", "path", "util"],
  ```

  `src/obsidian/git-port.ts` (vollständig):

  ```ts
  import { Platform } from "obsidian";
  import type { CommitPlan, GitPort, GitStatusInfo } from "../core/ports";

  /** Ausschnitt der Node-APIs, die dieser Port braucht — alle dynamisch importiert (siehe node()). */
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
   * - Node-Builtins (`child_process`, `util`, `fs/promises`, `path`) werden ausschließlich
   *   dynamisch per `import()` geladen und nur hinter `Platform.isDesktop` angefasst:
   *   ohne Import-Spuren im Modul-Top-Level bleibt das Bundle browser-sauber, und auf
   *   Mobile (das dieses Plugin wegen `isDesktopOnly` nie erreicht) gäbe es einen sauberen
   *   Fehler statt eines Ladecrashs. Specifier ohne `node:`-Präfix, passend zur
   *   external-Liste in esbuild.config.mjs.
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

    private async node(): Promise<NodeApis> {
      if (this.apis) return this.apis;
      if (!Platform.isDesktop) {
        throw new Error("vault-crews: GitPort benötigt Desktop (child_process nicht verfügbar).");
      }
      const [cp, util, fs, path] = await Promise.all([
        import("child_process"),
        import("util"),
        import("fs/promises"),
        import("path"),
      ]);
      const execFileP = util.promisify(cp.execFile);
      this.apis = {
        execFile: (file, args, opts) => execFileP(file, args, opts),
        access: (p) => fs.access(p),
        writeFile: (p, data, enc) => fs.writeFile(p, data, enc),
        unlink: (p) => fs.unlink(p),
        join: (...parts) => path.join(...parts),
        isAbsolute: (p) => path.isAbsolute(p),
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
      const n = await this.node();
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
      const n = await this.node();
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
      const n = await this.node();
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
      try {
        await this.git(["revert", "--no-edit", sha]);
        return { ok: true, conflictPaths: [] };
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
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```
  npx vitest run tests/integration/git-port.test.ts --config vitest.integration.config.ts --reporter=basic
  ```

  Erwartet: PASS, 12 Tests grün. Zusätzlich verifizieren, dass der Default-Lauf die Integrationstests NICHT aufnimmt und weiter grün ist:

  ```
  npx vitest run --reporter=basic
  ```

  Erwartet: alle bisherigen Unit-Tests grün, `tests/integration/git-port.test.ts` erscheint NICHT in der Datei-Liste.

- [ ] **Step 5: Commit** — vorher `npm run lint && npm run typecheck && npm test` grün.

  ```
  git add src/obsidian/git-port.ts tests/integration/git-port.test.ts vitest.integration.config.ts vitest.config.ts package.json esbuild.config.mjs && git commit -m "feat: ChildProcessGitPort (System-git via execFile) + Integrationstests

  Binary-Resolve /usr/bin/git vor PATH-git (macOS-GUI-PATH-Problem),
  status/applyPlan/revert/restorePaths, Commit-Message via .git/CREW_COMMIT_MSG (-F),
  Revert-Konflikt: Pfade sammeln, dann --abort. Eigenes npm-Skript test:integration
  (echtes git in mkdtemp), aus dem Default-npm-test ausgeschlossen.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 15: Obsidian-Adapter — ObsidianVaultPort/ObsidianMetadataPort + XhrSseTransport/RequestUrlJsonTransport

**Files:**
- Create: `src/obsidian/vault-port.ts`
- Create: `src/obsidian/transports.ts`
- Test: `tests/obsidian/vault-port.test.ts`, `tests/obsidian/transports.test.ts` (Smoke-Tests, laufen im Default-`npm test`)

**Interfaces:**
- Consumes (aus Task 3, `src/core/ports.ts`):
  ```ts
  export interface VaultPort {
    read(path: string): Promise<string>;
    create(path: string, content: string): Promise<void>;      // wirft, wenn existiert
    modify(path: string, content: string): Promise<void>;
    append(path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    patchFrontmatter(path: string, set: Record<string, string | number | null>, remove: string[]): Promise<void>;
  }
  export interface MetadataPort {
    listMarkdownFiles(folder: string): Promise<string[]>;
    getFrontmatter(path: string): Promise<Record<string, unknown> | null>;
    getBody(path: string): Promise<string>;
  }
  export interface SseTransport {
    postStream(url: string, body: unknown, onChunk: (raw: string) => void, signal: AbortSignal): Promise<number>;
  }
  export interface JsonTransport {
    getJson(url: string): Promise<unknown>;
    postJson(url: string, body: unknown): Promise<unknown>;
  }
  ```
  Außerdem aus Task 2: `tests/__mocks__/obsidian.ts` (`createObsidianMock`, `makeFakeApp`, `TFile`, `requestUrl`-Spy).
- Produces (für Task 16, Wiring in `main.ts`):
  ```ts
  export class ObsidianVaultPort implements VaultPort { constructor(app: App); }
  export class ObsidianMetadataPort implements MetadataPort { constructor(app: App); }
  export class XhrSseTransport implements SseTransport {}          // → LmStudioClient (Task 12)
  export class RequestUrlJsonTransport implements JsonTransport {} // → LmStudioClient (Task 12)
  ```

Diese Adapter sind bewusst dünn (Mock-Grenze = Port-Grenze, Spec §8): jede Methode delegiert 1:1 an genau eine Obsidian-API, alle Pfade laufen durch `normalizePath`. Getestet wird nur „ruft der Adapter die richtige API mit normalisiertem Pfad auf" — kein Deep-Mocking von `app`. Verhaltensverträge: `XhrSseTransport.postStream` **resolved mit dem HTTP-Status auch bei Nicht-2xx** (der `LmStudioClient` braucht den 400 für den Context-Overflow-Retry, §3.3) und liefert `onChunk` den **rohen Text-Delta** (`responseText`-Zuwachs seit `lastIndex`) — SSE-Parsing macht der Client über das vendorte `parseSSE`.

- [ ] **Step 1: Write the failing test (Zyklus A: VaultPort/MetadataPort)**

  `tests/obsidian/vault-port.test.ts` (vollständig):

  ```ts
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
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```
  npx vitest run tests/obsidian/vault-port.test.ts --reporter=basic
  ```

  Erwarteter Fehler: `Failed to resolve import "../../src/obsidian/vault-port" from "tests/obsidian/vault-port.test.ts"`.

- [ ] **Step 3: Write minimal implementation**

  `src/obsidian/vault-port.ts` (vollständig):

  ```ts
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
      return (cache?.frontmatter as Record<string, unknown> | undefined) ?? null;
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
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```
  npx vitest run tests/obsidian/vault-port.test.ts --reporter=basic
  ```

  Erwartet: PASS, 11 Tests grün.

- [ ] **Step 5: Zwischen-Commit** — vorher `npm run lint && npm run typecheck && npm test` grün.

  ```
  git add src/obsidian/vault-port.ts tests/obsidian/vault-port.test.ts && git commit -m "feat: ObsidianVaultPort + ObsidianMetadataPort (dünne Adapter, normalizePath überall)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: Write the failing test (Zyklus B: Transports)**

  `tests/obsidian/transports.test.ts` (vollständig):

  ```ts
  // Smoke-Tests der Transports. XhrSseTransport wird gegen einen injizierten Fake-XHR
  // getestet (vault-rag-Muster): der Test steuert onprogress/onload/onerror von außen.
  // requestUrl kommt als Spy aus dem vendorten Obsidian-Mock (gleiche Datei wie der
  // vitest-Alias `obsidian` → modul-identisch mit dem Import in transports.ts).
  import { afterEach, describe, expect, it, vi } from "vitest";
  import { requestUrl } from "../__mocks__/obsidian";
  import { RequestUrlJsonTransport, XhrSseTransport } from "../../src/obsidian/transports";

  class FakeXhr {
    static instances: FakeXhr[] = [];
    method = "";
    url = "";
    body = "";
    headers: Record<string, string> = {};
    status = 0;
    responseText = "";
    aborted = false;
    onprogress: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open(method: string, url: string): void { this.method = method; this.url = url; }
    setRequestHeader(k: string, v: string): void { this.headers[k] = v; }
    send(body: string): void { this.body = body; FakeXhr.instances.push(this); }
    abort(): void { this.aborted = true; this.onabort?.(); }
    // Test-Affordanzen:
    push(chunk: string): void { this.responseText += chunk; this.onprogress?.(); }
    finish(status: number): void { this.status = status; this.onload?.(); }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeXhr.instances = [];
  });

  describe("XhrSseTransport", () => {
    it("liefert onChunk nur die neuen Roh-Deltas (lastIndex) und resolved mit dem HTTP-Status", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const chunks: string[] = [];
      const p = new XhrSseTransport().postStream(
        "http://localhost:1234/v1/chat/completions",
        { model: "m" },
        (raw) => chunks.push(raw),
        new AbortController().signal,
      );
      const xhr = FakeXhr.instances[0]!;
      expect(xhr.method).toBe("POST");
      expect(xhr.url).toBe("http://localhost:1234/v1/chat/completions");
      expect(xhr.headers["Content-Type"]).toBe("application/json");
      expect(xhr.body).toBe('{"model":"m"}');

      xhr.push('data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n');
      xhr.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
      xhr.finish(200);

      expect(await p).toBe(200);
      expect(chunks).toEqual([
        'data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
      ]);
    });

    it("drained beim Load-Ende den Rest, der ohne onprogress-Event ankam", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const chunks: string[] = [];
      const p = new XhrSseTransport().postStream("http://x", {}, (raw) => chunks.push(raw), new AbortController().signal);
      const xhr = FakeXhr.instances[0]!;
      xhr.push("a");
      xhr.responseText += "b"; // kein onprogress mehr — nur onload sieht das
      xhr.finish(200);
      expect(await p).toBe(200);
      expect(chunks).toEqual(["a", "b"]);
    });

    it("resolved auch bei HTTP 400 mit dem Status (Context-Overflow-Handling im Client)", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const chunks: string[] = [];
      const p = new XhrSseTransport().postStream("http://x", {}, (raw) => chunks.push(raw), new AbortController().signal);
      const xhr = FakeXhr.instances[0]!;
      xhr.push('{"error":"context length exceeded"}');
      xhr.finish(400);
      expect(await p).toBe(400);
      expect(chunks).toEqual(['{"error":"context length exceeded"}']);
    });

    it("AbortSignal → xhr.abort() → Rejection mit AbortError", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const ctrl = new AbortController();
      const p = new XhrSseTransport().postStream("http://x", {}, () => {}, ctrl.signal);
      const xhr = FakeXhr.instances[0]!;
      ctrl.abort();
      expect(xhr.aborted).toBe(true);
      await expect(p).rejects.toMatchObject({ name: "AbortError" });
    });

    it("bereits abgebrochenes Signal → sofortige Rejection, ohne einen Request zu senden", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const ctrl = new AbortController();
      ctrl.abort();
      const p = new XhrSseTransport().postStream("http://x", {}, () => {}, ctrl.signal);
      await expect(p).rejects.toMatchObject({ name: "AbortError" });
      expect(FakeXhr.instances).toHaveLength(0);
    });

    it("rejected bei Netzwerkfehler", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const p = new XhrSseTransport().postStream("http://x", {}, () => {}, new AbortController().signal);
      FakeXhr.instances[0]!.onerror?.();
      await expect(p).rejects.toThrow(/Netzwerkfehler/);
    });
  });

  describe("RequestUrlJsonTransport", () => {
    it("getJson ruft requestUrl mit throw:false und parst den Text-Body", async () => {
      requestUrl.mockClear();
      requestUrl.mockResolvedValue({ status: 200, text: '{"data":[{"id":"m1"}]}', headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0) });
      const t = new RequestUrlJsonTransport();
      expect(await t.getJson("http://localhost:1234/v1/models")).toEqual({ data: [{ id: "m1" }] });
      expect(requestUrl.mock.calls[0]?.[0]).toMatchObject({
        url: "http://localhost:1234/v1/models",
        method: "GET",
        throw: false,
      });
    });

    it("postJson sendet JSON-Body mit throw:false und liefert null bei Nicht-JSON-Antwort", async () => {
      requestUrl.mockClear();
      requestUrl.mockResolvedValue({ status: 500, text: "Internal Server Error", headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0) });
      const t = new RequestUrlJsonTransport();
      expect(await t.postJson("http://localhost:1234/v1/chat/completions", { model: "m" })).toBeNull();
      expect(requestUrl.mock.calls[0]?.[0]).toMatchObject({
        method: "POST",
        throw: false,
        body: '{"model":"m"}',
        headers: { "Content-Type": "application/json" },
      });
    });
  });
  ```

- [ ] **Step 7: Run test to verify it fails**

  ```
  npx vitest run tests/obsidian/transports.test.ts --reporter=basic
  ```

  Erwarteter Fehler: `Failed to resolve import "../../src/obsidian/transports" from "tests/obsidian/transports.test.ts"`.

- [ ] **Step 8: Write minimal implementation**

  `src/obsidian/transports.ts` (vollständig):

  ```ts
  import { requestUrl } from "obsidian";
  import type { JsonTransport, SseTransport } from "../core/ports";

  /**
   * SSE-Streaming über XMLHttpRequest + onprogress (vault-rag-Muster):
   * Obsidians `requestUrl` kann nicht streamen, natives `fetch` ist lint-gesperrt —
   * XHR ist der erlaubte Streaming-Primitive. `responseText` akkumuliert; über
   * `lastIndex` wird nur der neue Tail als ROH-Delta an `onChunk` gereicht
   * (SSE-Parsing macht der LmStudioClient über das vendorte parseSSE).
   *
   * Vertrag: resolved mit dem HTTP-Status — AUCH bei Nicht-2xx (der Client braucht
   * z. B. den 400 samt Error-Body für den Context-Overflow-Retry, Spec §3.3).
   * AbortSignal → xhr.abort() → Rejection mit Error name="AbortError".
   */
  export class XhrSseTransport implements SseTransport {
    postStream(url: string, body: unknown, onChunk: (raw: string) => void, signal: AbortSignal): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const abortError = (): Error => {
          const e = new Error("Aborted");
          e.name = "AbortError";
          return e;
        };
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        const xhr = new XMLHttpRequest();
        let lastIndex = 0;
        const pump = (): void => {
          const text = xhr.responseText;
          if (text.length > lastIndex) {
            const delta = text.slice(lastIndex);
            lastIndex = text.length;
            onChunk(delta);
          }
        };
        xhr.open("POST", url);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onprogress = (): void => pump();
        xhr.onerror = (): void => reject(new Error(`vault-crews: Netzwerkfehler POST ${url}`));
        xhr.onabort = (): void => reject(abortError());
        xhr.onload = (): void => {
          pump(); // Rest drainen, der ohne onprogress-Event ankam
          resolve(xhr.status);
        };
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(JSON.stringify(body));
      });
    }
  }

  function parseBody(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null; // Nicht-JSON-Body (z. B. Plain-Text-Fehlerseite) → null, Client entscheidet
    }
  }

  /**
   * Non-Streaming-JSON über Obsidians `requestUrl` (CORS-frei) mit `throw: false`:
   * HTTP-Fehlerstatus wirft nicht, der (Fehler-)Body wird geparst durchgereicht.
   * Netzwerk-Fehler (Server weg) rejecten weiterhin — genau die Unterscheidung,
   * die der LmStudioClient für ping/listModels/modelInfo braucht.
   */
  export class RequestUrlJsonTransport implements JsonTransport {
    async getJson(url: string): Promise<unknown> {
      const r = await requestUrl({ url, method: "GET", throw: false });
      return parseBody(r.text);
    }

    async postJson(url: string, body: unknown): Promise<unknown> {
      const r = await requestUrl({
        url,
        method: "POST",
        throw: false,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseBody(r.text);
    }
  }
  ```

- [ ] **Step 9: Run test to verify it passes**

  ```
  npx vitest run tests/obsidian/transports.test.ts --reporter=basic
  ```

  Erwartet: PASS, 8 Tests grün. Danach Gesamtlauf: `npx vitest run --reporter=basic` — alle Dateien grün.

- [ ] **Step 10: Commit** — vorher `npm run lint && npm run typecheck && npm test` grün.

  ```
  git add src/obsidian/transports.ts tests/obsidian/transports.test.ts && git commit -m "feat: XhrSseTransport (XHR+onprogress, Roh-Deltas, Status-Resolve) + RequestUrlJsonTransport

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```