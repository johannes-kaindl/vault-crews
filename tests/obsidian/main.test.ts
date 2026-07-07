// Smoke-Tests der Plugin-Shell (Mock-Grenze = Port-Grenze, Spec §8): main.ts ist
// eine dünne Wiring-Schicht — hier wird NUR verdrahtet geprüft (Command-Registrierung,
// View-Typ, Settings-Tab, Ribbon/Statusbar, i18n-Registrierung) plus der Ein-Lauf-Mutex.
// KEIN Deep-Mocking von `app`, KEIN End-to-End-Lauf (das ist der Golden-Run, Task 19):
// der Orchestrator (`executeRun`) wird gemockt, damit `runCrew` einen kontrollierbaren,
// nie auflösenden Lauf startet und der Mutex isoliert beobachtbar wird.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeApp, Notice, Plugin, requestUrl } from "../__mocks__/obsidian";
import type { App, PluginManifest } from "obsidian";
import { setLang, t } from "../../src/vendor/kit/i18n";
import * as strings from "../../src/i18n/strings";
import { VIEW_TYPE_CREWS } from "../../src/obsidian/panel";
import { executeRun } from "../../src/core/orchestrator";
import type { RunResult } from "../../src/core/types";
import type { LlmClient } from "../../src/core/ports";
import VaultCrewsPlugin from "../../src/main";

vi.mock("../../src/core/orchestrator", () => ({ executeRun: vi.fn() }));

const MANIFEST: PluginManifest = {
  id: "vault-crews",
  name: "Vault Crews",
  version: "0.1.0",
  minAppVersion: "1.7.2",
  author: "Test",
  description: "Test fixture manifest",
};

function makePlugin(): VaultCrewsPlugin {
  return new VaultCrewsPlugin(makeFakeApp() as App, MANIFEST);
}

/** Reines Ergebnis-Objekt für den gemockten Lauf-Abschluss. */
function okResult(): RunResult {
  return { runId: "r1", status: "ok", undoable: false, writes: 0, durationS: 0, errorTask: null, errorKind: null, alwaysOnThinker: false };
}

beforeEach(() => {
  setLang("en");
  Notice.instances.length = 0;
  vi.mocked(executeRun).mockReset();
});
afterEach(() => {
  setLang("en");
  vi.restoreAllMocks();
});

describe("VaultCrewsPlugin.onload — wiring", () => {
  it("registers i18n and resolves known string keys", async () => {
    const registerSpy = vi.spyOn(strings, "registerI18n");
    const plugin = makePlugin();

    await plugin.onload();

    expect(registerSpy).toHaveBeenCalled();
    // Beweist registerI18n() + setLang(): ein bekannter Command-Key löst zur EN-Prosa auf.
    expect(t("cmd.abortRun")).toBe("Abort current run");
  });

  it("registers every static command (Spec §6.1)", async () => {
    const plugin = makePlugin();

    await plugin.onload();

    const ids = (plugin as unknown as { commands: { id: string }[] }).commands.map((c) => c.id);
    for (const id of [
      "run-crew",
      "abort-current-run",
      "undo-last-run",
      "open-crews-panel",
      "open-last-run-log",
      "install-example-crews",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("registers the run-panel view type", async () => {
    const plugin = makePlugin();

    await plugin.onload();

    const views = (plugin as unknown as { views: Record<string, unknown> }).views;
    expect(typeof views[VIEW_TYPE_CREWS]).toBe("function");
  });

  it("adds the settings tab, a ribbon icon and a status-bar item", async () => {
    const ribbonSpy = vi.spyOn(Plugin.prototype, "addRibbonIcon");
    const statusSpy = vi.spyOn(Plugin.prototype, "addStatusBarItem");
    const plugin = makePlugin();

    await plugin.onload();

    expect((plugin as unknown as { settingTabs: unknown[] }).settingTabs).toHaveLength(1);
    expect(ribbonSpy).toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalled();
  });
});

describe("VaultCrewsPlugin — one-run mutex", () => {
  it("blocks a second concurrent runCrew with one notice and never starts a second run", async () => {
    let resolveRun!: (r: RunResult) => void;
    vi.mocked(executeRun).mockReturnValue(new Promise<RunResult>((res) => { resolveRun = res; }));

    const plugin = makePlugin();
    await plugin.onload();

    // Ersten Lauf starten (nicht awaiten — er bleibt im gemockten executeRun hängen).
    void plugin.runCrew("task-triage");
    await Promise.resolve();
    await Promise.resolve();

    Notice.instances.length = 0; // nur die Mutex-Notice des zweiten Aufrufs beobachten
    await plugin.runCrew("task-triage");

    expect(vi.mocked(executeRun)).toHaveBeenCalledTimes(1);
    expect(Notice.instances).toHaveLength(1);
    expect(String(Notice.instances[0]?.message)).toBe("A run is already in progress.");

    // Aufräumen: den hängenden Lauf abschließen, damit keine offene Promise zurückbleibt.
    resolveRun(okResult());
    await Promise.resolve();
  });
});

describe("VaultCrewsPlugin.testConnection", () => {
  afterEach(() => {
    // Default-Verhalten (immer 200 + leerer Body) für nachfolgende Tests wiederherstellen.
    requestUrl.mockImplementation(() => Promise.resolve({
      status: 200, headers: {}, text: "", json: {}, arrayBuffer: new ArrayBuffer(0),
    }));
  });

  it("pings/lists via an ephemeral client pinned to the tested endpoint, never the shared this.llm", async () => {
    const bodyFor = (id: string): string => JSON.stringify({ data: [{ id }] });
    requestUrl.mockClear();
    requestUrl.mockImplementation((opts: unknown) => {
      const url = typeof opts === "string" ? opts : (opts as { url: string }).url;
      if (url.startsWith("http://race-endpoint:5555")) {
        return Promise.resolve({ status: 200, headers: {}, text: bodyFor("race-model"), json: {}, arrayBuffer: new ArrayBuffer(0) });
      }
      if (url.startsWith("http://endpoint-b:9999")) {
        return Promise.resolve({ status: 200, headers: {}, text: bodyFor("model-b"), json: {}, arrayBuffer: new ArrayBuffer(0) });
      }
      return Promise.resolve({ status: 500, headers: {}, text: "", json: {}, arrayBuffer: new ArrayBuffer(0) });
    });

    const plugin = makePlugin();
    await plugin.onload();

    // Simuliert das Preflight-Failover eines LAUFENDEN Runs, der den geteilten
    // this.llm bereits auf einen dritten Endpoint umgebogen hat (setBase()).
    const sharedLlm = (plugin as unknown as { llm: LlmClient }).llm;
    sharedLlm.setBase("http://race-endpoint:5555");

    const result = await plugin.testConnection("http://endpoint-b:9999");

    expect(result).toEqual({ ok: true, models: ["model-b"] });
    // Der geteilte Client darf von testConnection nie berührt worden sein — er zeigt
    // weiterhin auf den vom (simulierten) Lauf gesetzten race-endpoint, nicht auf
    // endpoint-b und auch nicht zurück auf den onload-Default.
    await expect(sharedLlm.listModels()).resolves.toEqual(["race-model"]);
  });
});
