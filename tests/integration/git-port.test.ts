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
// Nur TRAILING Newlines strippen (nicht .trim()): `git status --porcelain` codiert einen
// "Index unverändert"-Status als führendes Leerzeichen (z. B. " M note.md") — .trim() würde
// dieses führende Zeichen mitentfernen und den Unterschied zu "gestaged" (z. B. "M  note.md")
// unsichtbar machen.
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.replace(/\r?\n+$/, "");
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
