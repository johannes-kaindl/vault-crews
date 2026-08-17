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

describe("VaultCrewsPlugin.probeEndpoint", () => {
  afterEach(() => {
    requestUrl.mockImplementation(() => Promise.resolve({
      status: 200, headers: {}, text: "", json: {}, arrayBuffer: new ArrayBuffer(0),
    }));
  });

  it("classifies a reachable OpenAI-compatible endpoint as ok", async () => {
    requestUrl.mockClear();
    requestUrl.mockImplementation(() => Promise.resolve({
      status: 200, headers: {}, text: JSON.stringify({ data: [{ id: "m1" }] }), json: {}, arrayBuffer: new ArrayBuffer(0),
    }));
    const plugin = makePlugin();
    await plugin.onload();

    const status = await plugin.probeEndpoint({ url: "http://endpoint-b:9999" });

    expect(status.kind).toBe("ok");
    expect(status.reachable).toBe(true);
  });

  it("classifies a responding non-LLM server as not-an-llm-api", async () => {
    requestUrl.mockClear();
    requestUrl.mockImplementation(() => Promise.resolve({
      status: 200, headers: {}, text: JSON.stringify({ hello: "world" }), json: {}, arrayBuffer: new ArrayBuffer(0),
    }));
    const plugin = makePlugin();
    await plugin.onload();

    const status = await plugin.probeEndpoint({ url: "http://endpoint-b:9999" });

    expect(status.kind).toBe("not-an-llm-api");
    expect(status.reachable).toBe(false);
  });

  it("classifies a network-refused endpoint as refused", async () => {
    requestUrl.mockClear();
    requestUrl.mockImplementation(() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1234")));
    const plugin = makePlugin();
    await plugin.onload();

    const status = await plugin.probeEndpoint({ url: "http://endpoint-b:9999" });

    expect(status.kind).toBe("refused");
    expect(status.reachable).toBe(false);
  });

  it("never touches the shared this.llm client (probe is isolated from a running run)", async () => {
    requestUrl.mockClear();
    requestUrl.mockImplementation(() => Promise.resolve({
      status: 200, headers: {}, text: JSON.stringify({ data: [{ id: "race-model" }] }), json: {}, arrayBuffer: new ArrayBuffer(0),
    }));
    const plugin = makePlugin();
    await plugin.onload();
    const sharedLlm = (plugin as unknown as { llm: LlmClient }).llm;
    sharedLlm.setEndpoint({ url: "http://race-endpoint:5555" });

    await plugin.probeEndpoint({ url: "http://endpoint-b:9999" });

    // Der geteilte Client zeigt unverändert auf den vom (simulierten) Lauf gesetzten Endpoint.
    await expect(sharedLlm.listModels()).resolves.toEqual(["race-model"]);
  });
});

describe("VaultCrewsPlugin.listModels / resolveActive", () => {
  afterEach(() => {
    requestUrl.mockImplementation(() => Promise.resolve({
      status: 200, headers: {}, text: "", json: {}, arrayBuffer: new ArrayBuffer(0),
    }));
  });

  it("listet die Modelle GENAU EINER Zeile — der Editor fragt je Zeile, nicht global", async () => {
    requestUrl.mockClear();
    requestUrl.mockImplementation((opts: unknown) => {
      const url = typeof opts === "string" ? opts : (opts as { url: string }).url;
      if (url.startsWith("http://live:2")) {
        return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify({ data: [{ id: "model-x" }] }), json: {}, arrayBuffer: new ArrayBuffer(0) });
      }
      return Promise.reject(new Error("connect ECONNREFUSED"));
    });
    const plugin = makePlugin();
    await plugin.onload();

    await expect(plugin.listModels({ url: "http://live:2" })).resolves.toEqual(["model-x"]);
    await expect(plugin.listModels({ url: "http://dead:1" })).resolves.toEqual([]);
  });

  it("loest den ersten erreichbaren Eintrag auf, sonst null", async () => {
    requestUrl.mockClear();
    requestUrl.mockImplementation((opts: unknown) => {
      const url = typeof opts === "string" ? opts : (opts as { url: string }).url;
      if (url.startsWith("http://live:2")) {
        return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify({ data: [{ id: "model-x" }] }), json: {}, arrayBuffer: new ArrayBuffer(0) });
      }
      return Promise.reject(new Error("connect ECONNREFUSED"));
    });
    const plugin = makePlugin();
    await plugin.onload();
    (plugin as unknown as { settings: { endpoints: { url: string }[] } }).settings.endpoints =
      [{ url: "http://dead:1" }, { url: "http://live:2" }];

    await expect(plugin.resolveActive()).resolves.toBe("http://live:2");
  });

  it("liefert null, wenn nichts erreichbar ist", async () => {
    requestUrl.mockClear();
    requestUrl.mockImplementation(() => Promise.reject(new Error("connect ECONNREFUSED")));
    const plugin = makePlugin();
    await plugin.onload();
    (plugin as unknown as { settings: { endpoints: { url: string }[] } }).settings.endpoints = [{ url: "http://dead:1" }];

    await expect(plugin.resolveActive()).resolves.toBeNull();
  });

  // Der Schluessel muss die Erreichbarkeitsprobe erreichen: ein Gateway, das
  // unauthentifiziert 401 antwortet, gaelte sonst als tot und wuerde still uebersprungen.
  it("schickt den Schluessel der Zeile an die Probe mit", async () => {
    requestUrl.mockClear();
    const seen: Record<string, string>[] = [];
    requestUrl.mockImplementation((opts: unknown) => {
      const o = opts as { url: string; headers?: Record<string, string> };
      seen.push(o.headers ?? {});
      return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify({ data: [] }), json: {}, arrayBuffer: new ArrayBuffer(0) });
    });
    const plugin = makePlugin();
    await plugin.onload();

    await plugin.probeEndpoint({ url: "http://gw:1", apiKey: "sk-test-key-123" });

    expect(seen.some((h) => h.Authorization === "Bearer sk-test-key-123")).toBe(true);
  });
});

describe("VaultCrewsPlugin.loadSettings — Migration", () => {
  // Der GUI-Smoke fand es: mergeSettings kopiert JEDES Feld der alten data.json ins
  // Settings-Objekt, auch das gestrichene `defaultModel`. Es blieb danach unbenutzt liegen
  // und wurde bei jedem Speichern wieder in die Datei geschrieben — ein Feld, dessen
  // Abschaffung das CHANGELOG ankuendigt, ueberlebte die Migration.
  it("laesst das abgeschaffte defaultModel nicht im Settings-Objekt zurueck", async () => {
    const plugin = makePlugin();
    (plugin as unknown as { loadData(): Promise<unknown> }).loadData = () =>
      Promise.resolve({ endpoints: ["http://a:1"], defaultModel: "altes-modell" });

    await plugin.loadSettings();

    const s = (plugin as unknown as { settings: Record<string, unknown> }).settings;
    expect(s.endpoints).toEqual([{ url: "http://a:1", model: "altes-modell" }]);
    expect("defaultModel" in s).toBe(false);
  });
});
