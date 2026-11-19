// Smoke-Tests der Plugin-Shell (Mock-Grenze = Port-Grenze, Spec §8): main.ts ist
// eine dünne Wiring-Schicht — hier wird NUR verdrahtet geprüft (Command-Registrierung,
// View-Typ, Settings-Tab, Ribbon/Statusbar, i18n-Registrierung) plus der Ein-Lauf-Mutex.
// KEIN Deep-Mocking von `app`, KEIN End-to-End-Lauf (das ist der Golden-Run, Task 19):
// der Orchestrator (`executeRun`) wird gemockt, damit `runCrew` einen kontrollierbaren,
// nie auflösenden Lauf startet und der Mutex isoliert beobachtbar wird.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeApp, Modal, Notice, Plugin, requestUrl, TFile } from "../__mocks__/obsidian";
import type { App, PluginManifest } from "obsidian";
import { setLang, t } from "../../src/vendor/kit/i18n";
import * as strings from "../../src/i18n/strings";
import { VIEW_TYPE_CREWS } from "../../src/obsidian/panel";
import { executeRun, type RunDeps } from "../../src/core/orchestrator";
import { requestUrlTransport, xhrSseTransport } from "../../src/vendor/kit-obsidian/chat-transport";
import type { RunResult } from "../../src/core/types";
import type { LlmClient } from "../../src/core/ports";
import { InMemoryVaultPort } from "../helpers/in-memory-vault";
import { FakeSnapshotStore } from "../helpers/fake-snapshot";
import { fnv1a } from "../../src/core/collectors";
import type { UndoPlan } from "../../src/core/undo-plan";
import VaultCrewsPlugin from "../../src/main";
import { LLM_CONNECTION_STRINGS_EN, managerErrorText } from "../../src/vendor/kit-obsidian/llm-connection-strings";

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

/** Das Blatt, das der Mock-Realm (`rootSplit.doc.defaultView.CSSStyleSheet`) erzeugt. */
interface FakeSheet { css: string }

beforeEach(() => {
  setLang("en");
  Notice.instances.length = 0;
  vi.mocked(executeRun).mockReset();
});
afterEach(() => {
  setLang("en");
  vi.unstubAllGlobals();
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
      "show-crew-folder",
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

describe("VaultCrewsPlugin.modelContext — Kontextlänge unter der Endpunkt-Zeile (Welle 18)", () => {
  afterEach(() => {
    requestUrl.mockImplementation(() => Promise.resolve({
      status: 200, headers: {}, text: "", json: {}, arrayBuffer: new ArrayBuffer(0),
    }));
  });

  const antwort = (body: unknown) => Promise.resolve({ status: 200, headers: {}, text: JSON.stringify(body), json: {}, arrayBuffer: new ArrayBuffer(0) });
  const urlOf = (opts: unknown): string => (typeof opts === "string" ? opts : (opts as { url: string }).url);

  it("liest geladene und maximale Länge, schickt den Schlüssel mit und merkt sich das Ergebnis je (URL, Modell)", async () => {
    requestUrl.mockClear();
    requestUrl.mockImplementation((opts: unknown) => urlOf(opts).endsWith("/api/v0/models")
      ? antwort({ data: [{ id: "m1", max_context_length: 32768, loaded_context_length: 8192 }] })
      : Promise.reject(new Error("unerwartet")));
    const plugin = makePlugin();
    await plugin.onload();
    const row = { url: "http://gw:1234", model: "m1", apiKey: "sk-zeile" };

    await expect(plugin.modelContext(row)).resolves.toEqual({ loadedContextLength: 8192, maxContextLength: 32768 });
    const first = requestUrl.mock.calls[0]?.[0] as { headers?: Record<string, string> };
    expect(first.headers?.Authorization).toBe("Bearer sk-zeile");

    const n = requestUrl.mock.calls.length;
    await plugin.modelContext(row);
    expect(requestUrl.mock.calls.length).toBe(n);            // Zwischenspeicher
    plugin.resetModelContext(row);
    await plugin.modelContext(row);
    expect(requestUrl.mock.calls.length).toBeGreaterThan(n); // „Modelle neu laden“ fragt neu
  });

  it("ohne Modell kein Abruf, und ein Server ohne Zahl ergibt null", async () => {
    requestUrl.mockClear();
    requestUrl.mockImplementation(() => antwort({ data: [] }));
    const plugin = makePlugin();
    await plugin.onload();
    await expect(plugin.modelContext({ url: "http://gw:1234" })).resolves.toBeNull();
    expect(requestUrl.mock.calls.length).toBe(0);
    await expect(plugin.modelContext({ url: "http://gw:1234", model: "x" })).resolves.toBeNull();
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

  it("laesst das gestrichene verboseLogging nicht im Settings-Objekt zurueck", async () => {
    const plugin = makePlugin();
    (plugin as unknown as { loadData(): Promise<unknown> }).loadData = () =>
      Promise.resolve({ verboseLogging: true, maxWrites: 7 });

    await plugin.loadSettings();

    const s = (plugin as unknown as { settings: Record<string, unknown> }).settings;
    expect(s.maxWrites).toBe(7);
    expect("verboseLogging" in s).toBe(false);
  });
});

describe("VaultCrewsPlugin.loadSettings — Untergrenzen der Zahlenfelder (Welle 36)", () => {
  // Beim Laden wird geklemmt wie in setControlValue; nur NaN, Text oder ein fehlender Wert ergeben den Standard.
  const FELDER: Array<{ key: string; min: number; standard: number }> = [
    { key: "wallClockMinutes", min: 1, standard: 10 },
    { key: "callTimeoutS", min: 10, standard: 300 },
    { key: "stallTimeoutS", min: 5, standard: 60 },
    { key: "maxWrites", min: 0, standard: 10 },
    { key: "undoHistoryDepth", min: 1, standard: 15 },
  ];
  const lade = async (data: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const plugin = makePlugin();
    (plugin as unknown as { loadData(): Promise<unknown> }).loadData = () => Promise.resolve(data);
    await plugin.loadSettings();
    return (plugin as unknown as { settings: Record<string, unknown> }).settings;
  };

  for (const { key, min, standard } of FELDER) {
    it(`${key}: -5 aus der data.json wird auf ${min} geklemmt`, async () => {
      expect((await lade({ [key]: -5 }))[key]).toBe(min);
    });
    it(`${key}: 0 ergibt ${min}`, async () => {
      expect((await lade({ [key]: 0 }))[key]).toBe(min);
    });
    it(`${key}: Text und NaN ergeben den Standard ${standard}`, async () => {
      expect((await lade({ [key]: "abc" }))[key]).toBe(standard);
      expect((await lade({ [key]: Number.NaN }))[key]).toBe(standard);
      expect((await lade({ [key]: null }))[key]).toBe(standard);
    });
    it(`${key}: 2.7 wird wie in setControlValue abgeschnitten, dann geklemmt`, async () => {
      expect((await lade({ [key]: 2.7 }))[key]).toBe(Math.max(min, 2));
    });
    it(`${key}: fehlender Wert ergibt den Standard, ein gültiger Wert bleibt`, async () => {
      expect((await lade({}))[key]).toBe(standard);
      expect((await lade({ [key]: min + 3 }))[key]).toBe(min + 3);
    });
  }

  it("callTimeoutS und stallTimeoutS werden beim Laden auf 86400 begrenzt (setTimeout feuert über 2^31 ms sofort)", async () => {
    expect((await lade({ callTimeoutS: 10 ** 9 })).callTimeoutS).toBe(86400);
    expect((await lade({ stallTimeoutS: 86401 })).stallTimeoutS).toBe(86400);
    expect((await lade({ stallTimeoutS: 86400 })).stallTimeoutS).toBe(86400);
  });

  it("maxWrites 0 bleibt 0 (gewollter Schreibstopp), negative Werte werden 0", async () => {
    expect((await lade({ maxWrites: 0 })).maxWrites).toBe(0);
    expect((await lade({ maxWrites: -1 })).maxWrites).toBe(0);
  });
});

describe("VaultCrewsPlugin — Mitschnitt je Modellaufruf (Welle 36)", () => {
  const settings = (p: VaultCrewsPlugin): Record<string, unknown> => (p as unknown as { settings: Record<string, unknown> }).settings;
  const loaded = async (data: unknown): Promise<VaultCrewsPlugin> => {
    const plugin = makePlugin();
    (plugin as unknown as { loadData(): Promise<unknown> }).loadData = () => Promise.resolve(data);
    await plugin.onload();
    return plugin;
  };

  it("Standard aus; nur ein gespeichertes true schaltet ein, Muell und fehlender Schluessel bleiben aus", async () => {
    expect(settings(await loaded(null)).recordCalls).toBe(false);
    expect(settings(await loaded({ maxWrites: 7 })).recordCalls).toBe(false);
    expect(settings(await loaded({ recordCalls: "ja" })).recordCalls).toBe(false);
    expect(settings(await loaded({ recordCalls: true })).recordCalls).toBe(true);
  });

  it("Schalter in den Einstellungen setzt und speichert den Wert", async () => {
    const plugin = await loaded(null);
    const saved: unknown[] = [];
    (plugin as unknown as { saveData(d: unknown): Promise<void> }).saveData = (d) => { saved.push(d); return Promise.resolve(); };
    const tab = (plugin as unknown as { settingTabs: { setControlValue(k: string, v: unknown): void; getControlValue(k: string): unknown }[] }).settingTabs[0];
    tab.setControlValue("recordCalls", true);
    expect(tab.getControlValue("recordCalls")).toBe(true);
    await Promise.resolve();
    expect(saved.at(-1)).toMatchObject({ recordCalls: true });
  });

  /** Startet einen Lauf und gibt die Abhaengigkeiten zurueck, die der Orchestrator bekam, dazu die Transporte des Clients. */
  async function runWith(recordCalls: boolean): Promise<{ deps: RunDeps; transports: { transport: unknown; fallbackTransport: unknown } }> {
    vi.mocked(executeRun).mockResolvedValue(okResult());
    const plugin = await loaded({ recordCalls });
    plugin.runCrew("task-triage");
    await vi.waitFor(() => { expect(executeRun).toHaveBeenCalled(); });
    const deps = vi.mocked(executeRun).mock.calls[0]![1];
    const transports = (deps.llm as unknown as { transports: { transport: unknown; fallbackTransport: unknown } }).transports;
    return { deps, transports };
  }

  it("an: der Lauf bekommt einen Recorder und beide Chat-Transporte sind umhuellt", async () => {
    const { deps, transports } = await runWith(true);
    expect(deps.callLog).toBeDefined();
    expect(transports.transport).not.toBe(xhrSseTransport);
    expect(transports.fallbackTransport).not.toBe(requestUrlTransport);
  });

  it("aus (Gegenprobe): kein Recorder, die Transporte sind die unveraenderten", async () => {
    const { deps, transports } = await runWith(false);
    expect(deps.callLog).toBeUndefined();
    expect(transports.transport).toBe(xhrSseTransport);
    expect(transports.fallbackTransport).toBe(requestUrlTransport);
  });
});

describe("VaultCrewsPlugin — Statusleiste (Welle 34)", () => {
  type Handle = { shown: boolean; el: { textContent?: string } | null };
  const item = (p: VaultCrewsPlugin): Handle => (p as unknown as { statusItem: Handle }).statusItem;
  const settings = (p: VaultCrewsPlugin): Record<string, unknown> => (p as unknown as { settings: Record<string, unknown> }).settings;
  const loaded = async (data: unknown): Promise<VaultCrewsPlugin> => {
    const plugin = makePlugin();
    (plugin as unknown as { loadData(): Promise<unknown> }).loadData = () => Promise.resolve(data);
    await plugin.onload();
    return plugin;
  };

  it("frische Installation und alte data.json ohne den Schluessel: Eintrag steht in der Leiste", async () => {
    expect(settings(await loaded(null)).showStatusBar).toBe(true);
    const alt = await loaded({ maxWrites: 7, hideCrewFolder: true });
    expect(settings(alt).showStatusBar).toBe(true);
    expect(item(alt).shown).toBe(true);
  });

  it("Muell im Schluessel faellt auf an, ein gespeichertes false bleibt aus (kein Eintrag angelegt)", async () => {
    expect(settings(await loaded({ showStatusBar: "nein" })).showStatusBar).toBe(true);
    const aus = await loaded({ showStatusBar: false });
    expect(item(aus).shown).toBe(false);
    expect(item(aus).el).toBeNull();
  });

  it("Umschalten ueber die Einstellungen haengt den Eintrag ab und legt ihn neu an, der Wert wird gespeichert", async () => {
    const plugin = await loaded(null);
    const saved: unknown[] = [];
    (plugin as unknown as { saveData(d: unknown): Promise<void> }).saveData = (d) => { saved.push(d); return Promise.resolve(); };
    const tab = (plugin as unknown as { settingTabs: { setControlValue(k: string, v: unknown): void }[] }).settingTabs[0];

    tab.setControlValue("showStatusBar", false);
    await Promise.resolve(); await Promise.resolve();
    expect(item(plugin).shown).toBe(false);
    expect(saved.at(-1)).toMatchObject({ showStatusBar: false });

    tab.setControlValue("showStatusBar", true);
    await Promise.resolve(); await Promise.resolve();
    expect(item(plugin).shown).toBe(true);
    expect(saved.at(-1)).toMatchObject({ showStatusBar: true });
  });

  it("die Laufanzeige schreibt in den Eintrag und raeumt ihn am Laufende; bei ausgeschalteter Leiste bricht nichts", async () => {
    const plugin = await loaded(null);
    const onRunEvent = (plugin as unknown as { onRunEvent(id: string, e: unknown): void }).onRunEvent.bind(plugin);
    onRunEvent("t", { type: "taskStarted", index: 2, total: 5 });
    expect(item(plugin).el!.textContent).toBe("⚙ 2/5");

    const aus = await loaded({ showStatusBar: false });
    const onRunEventAus = (aus as unknown as { onRunEvent(id: string, e: unknown): void }).onRunEvent.bind(aus);
    expect(() => onRunEventAus("t", { type: "taskStarted", index: 1, total: 3 })).not.toThrow();
  });
});

// Zwei der drei stummen Panel-Zustaende haengen an der Wiring-Schicht, nicht am ViewModel:
// das Zaehlen verirrter Dateien und das Nachziehen bei Vault-Aenderungen.
describe("VaultCrewsPlugin — verirrte Crew-Dateien und Live-Aktualisierung", () => {
  /** Baut ein App-Double, dessen Vault die genannten Pfade fuehrt; jeder Pfad mit
   *  `crewKind` bekommt entsprechendes Frontmatter. */
  function appWithFiles(files: Record<string, string | null>): any {
    const app = makeFakeApp();
    const tfiles = Object.keys(files).map((path) => {
      const f = new TFile();
      (f as unknown as { path: string }).path = path;
      return f;
    });
    app.vault.getMarkdownFiles.mockReturnValue(tfiles);
    app.vault.getAbstractFileByPath.mockImplementation((p: string) =>
      tfiles.find((f) => (f as unknown as { path: string }).path === p) ?? null);
    app.metadataCache.getFileCache.mockImplementation((f: unknown) => {
      const path = (f as { path: string }).path;
      const kind = files[path];
      return kind === null || kind === undefined ? null : { frontmatter: { "crew-kind": kind } };
    });
    return app;
  }

  async function loadedWith(files: Record<string, string | null>): Promise<VaultCrewsPlugin> {
    const plugin = new VaultCrewsPlugin(appWithFiles(files) as App, MANIFEST);
    await plugin.onload();
    await vi.waitFor(() => { expect(plugin.getStrayCrewCount()).toBeGreaterThanOrEqual(0); });
    return plugin;
  }

  it("zaehlt nur Dateien mit crew-kind, die FLACH im crewRoot liegen", async () => {
    const plugin = await loadedWith({
      "_crews/verirrt.md": "team",          // zaehlt
      "_crews/auch-verirrt.md": "agent",    // zaehlt
      "_crews/teams/richtig.md": "team",    // liegt korrekt → zaehlt nicht
      "_crews/agents/richtig.md": "agent",  // liegt korrekt → zaehlt nicht
      "_crews/notiz.md": null,              // kein crew-kind → zaehlt nicht
      "woanders/fremd.md": "team",          // ausserhalb des crewRoot → zaehlt nicht
    });
    await vi.waitFor(() => { expect(plugin.getStrayCrewCount()).toBe(2); });
  });

  it("meldet 0, wenn nichts verirrt ist — kein Hinweis ohne Anlass", async () => {
    const plugin = await loadedWith({ "_crews/teams/richtig.md": "team" });
    await vi.waitFor(() => { expect(plugin.getStrayCrewCount()).toBe(0); });
  });

  // Das Panel baute seine Liste nur beim Oeffnen: wer eine Crew anlegte, sah sie erst
  // nach Schliessen und erneutem Oeffnen.
  it("horcht auf create, delete, rename und modify im Vault", async () => {
    const app = appWithFiles({ "_crews/teams/t.md": "team" });
    const plugin = new VaultCrewsPlugin(app as App, MANIFEST);
    await plugin.onload();
    await vi.waitFor(() => {
      const events = app.vault.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(events).toEqual(expect.arrayContaining(["create", "delete", "rename", "modify"]));
    });
  });
});

describe("VaultCrewsPlugin — Crew-Ordner im Explorer ausblenden", () => {
  it("haengt beim Laden ein Stylesheet an und versteckt den Ordner erst, wenn der Schalter an ist", async () => {
    const app = makeFakeApp();
    const plugin = new VaultCrewsPlugin(app as App, MANIFEST);
    await plugin.onload();

    const doc = (app as unknown as { workspace: { rootSplit: { doc: { adoptedStyleSheets: FakeSheet[] } } } }).workspace.rootSplit.doc;
    const sheets = doc.adoptedStyleSheets;
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.css).toBe("");

    plugin.settings.hideCrewFolder = true;
    await plugin.saveSettings();
    expect(sheets[0]?.css).toContain('.nav-folder-title[data-path="_crews"]');

    plugin.onunload();
    expect(doc.adoptedStyleSheets).toHaveLength(0);
  });
});

describe("VaultCrewsPlugin — Endpunkte vom LLM Endpoint Manager", () => {
  const LOCAL = [{ url: "http://localhost:1234/v1" }];

  /** Fake-App mit einem Manager-Plugin, dessen `api` der Vertrag v1 erfuellt. */
  function appWithManager(resolveResult: unknown): { app: App; resolve: ReturnType<typeof vi.fn> } {
    const app = makeFakeApp() as App;
    const resolve = vi.fn().mockResolvedValue(resolveResult);
    const api = {
      version: 1, list: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), resolve,
      materialize: vi.fn().mockResolvedValue({ error: "not-found" }), models: vi.fn().mockResolvedValue([]),
      importEndpoints: vi.fn(), on: vi.fn().mockReturnValue(() => {}),
    };
    (app as unknown as { plugins: unknown }).plugins = { plugins: { "llm-endpoint-manager": { api } } };
    return { app, resolve };
  }

  async function endpointsPassedToRun(app: App): Promise<unknown> {
    vi.mocked(executeRun).mockResolvedValue(okResult());
    const plugin = new VaultCrewsPlugin(app, MANIFEST);
    await plugin.onload();
    plugin.runCrew("task-triage");
    // Nicht mehr „zehn Mikrotask-Ticks": die Quellenwahl fragt inzwischen auch das Backend des
    // gewählten Endpunkts (Probe), die Zahl der Schritte bis `executeRun` ist kein Vertrag.
    await vi.waitFor(() => { expect(executeRun).toHaveBeenCalled(); });
    const deps = vi.mocked(executeRun).mock.calls[0]?.[1];
    return deps?.settings.endpoints;
  }

  it("nimmt bei installiertem Manager dessen Endpunkt samt Schluessel und Modell", async () => {
    const { app, resolve } = appWithManager({
      id: "e1", label: "Manager", config: { url: "http://gw/v1", apiKey: "sk-x" }, defaultModel: "m-default",
    });
    const endpoints = await endpointsPassedToRun(app);
    expect(resolve).toHaveBeenCalledWith("chat", { caller: "vault-crews" });
    expect(endpoints).toEqual([{ url: "http://gw/v1", apiKey: "sk-x", model: "m-default" }]);
  });

  it("uebergibt bei Manager-Fehler eine leere Liste — kein stiller Rueckfall auf lokal", async () => {
    const { app } = appWithManager({ error: "no-endpoint" });
    expect(await endpointsPassedToRun(app)).toEqual([]);
  });

  it("nimmt ohne Manager die lokale Liste unveraendert", async () => {
    expect(await endpointsPassedToRun(makeFakeApp() as App)).toEqual(LOCAL);
  });
});

describe("VaultCrewsPlugin — API-Schluessel im Schluesselbund", () => {
  const KEY = "sk-geheim-1234567890";

  /** Fake-App mit `app.secretStorage` (Map), sonst wie jede andere. */
  function appWithSecretStorage(): { app: App; store: Map<string, string> } {
    const app = makeFakeApp() as App;
    const store = new Map<string, string>();
    (app as unknown as { secretStorage: unknown }).secretStorage = {
      getSecret: (id: string) => store.get(id) ?? "",
      setSecret: (id: string, v: string) => { store.set(id, v); },
    };
    return { app, store };
  }

  async function runWithKey(app: App): Promise<{ plugin: VaultCrewsPlugin; passed: unknown }> {
    vi.mocked(executeRun).mockResolvedValue(okResult());
    const plugin = new VaultCrewsPlugin(app, MANIFEST);
    await plugin.onload();
    plugin.settings.endpoints = [{ url: "http://gw:1", apiKey: KEY, model: "m" }];
    plugin.runCrew("task-triage");
    await vi.waitFor(() => { expect(executeRun).toHaveBeenCalled(); });
    return { plugin, passed: vi.mocked(executeRun).mock.calls[0]?.[1].settings.endpoints };
  }

  it("legt einen Klartext-Schluessel beim Aufloesen im Schluesselbund ab und nimmt ihn aus den Settings", async () => {
    const { app, store } = appWithSecretStorage();
    const { plugin } = await runWithKey(app);
    expect([...store.values()]).toContain(KEY);
    const saved = plugin.settings.endpoints[0];
    expect(saved).toBeDefined();
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved?.secretId).toBeTruthy();
    expect(JSON.stringify(plugin.settings)).not.toContain(KEY);
  });

  it("reicht dem Lauf den Schluessel aus dem Schluesselbund — damit redactRunState ihn in run.md schwaerzen kann", async () => {
    const { app } = appWithSecretStorage();
    const { passed } = await runWithKey(app);
    expect(passed).toEqual([expect.objectContaining({ url: "http://gw:1", apiKey: KEY, model: "m" })]);
  });
});

describe("Grund des LLM Endpoint Managers in der Verweigerung", () => {
  function fakeManager(over: Record<string, unknown>) {
    const m = {
      version: 1, list: () => [], get: () => null, models: async () => [], importEndpoints: async () => ({ added: [], merged: [], skipped: [] }),
      on: () => () => {}, resolve: async () => ({ error: "no-endpoint" }), materialize: async () => ({ error: "no-endpoint" }), ...over,
    };
    return m;
  }
  async function pluginWith(manager: unknown, choice: { endpointId?: string } = {}) {
    const app = makeFakeApp() as unknown as { plugins: unknown };
    app.plugins = { plugins: { "llm-endpoint-manager": { api: manager } } };
    const plugin = new VaultCrewsPlugin(app as unknown as App, MANIFEST);
    await plugin.onload();
    (plugin as unknown as { settings: { choice: unknown } }).settings.choice = choice;
    await plugin.effectiveEndpoints();
    return plugin as unknown as { managerRefusalReason(): string | null; showRunNotice(id: string, r: RunResult): void };
  }
  const refused: RunResult = { runId: "r1", status: "refused", undoable: false, writes: 0, durationS: 0, errorTask: null, errorKind: "endpoint_unreachable", alwaysOnThinker: false };

  it.each([
    ["no-endpoint", { resolve: async () => ({ error: "no-endpoint" }) }, {}],
    ["secret-missing", { materialize: async () => ({ error: "secret-missing" }) }, { endpointId: "e1" }],
    ["disabled", { materialize: async () => ({ error: "disabled" }) }, { endpointId: "e1" }],
  ])("%s: der Notice nennt den Grund des Managers statt „Start LM Studio“", async (code, over, choice) => {
    const plugin = await pluginWith(fakeManager(over), choice);
    expect(plugin.managerRefusalReason()).toBe(code);
    plugin.showRunNotice("team", refused);
    const msg = String(Notice.instances.at(-1)?.message ?? "");
    expect(msg).not.toContain("Start LM Studio");
    expect(msg).toContain(managerErrorText(LLM_CONNECTION_STRINGS_EN, code));
  });

  it("ohne Manager bleibt es bei der allgemeinen Zeile", async () => {
    const plugin = new VaultCrewsPlugin(makeFakeApp() as App, MANIFEST);
    await plugin.onload();
    await plugin.effectiveEndpoints();
    (plugin as unknown as { showRunNotice(id: string, r: RunResult): void }).showRunNotice("team", refused);
    expect(String(Notice.instances.at(-1)?.message ?? "")).toContain("Start LM Studio");
  });
});


describe("VaultCrewsPlugin — Heartbeat", () => {
  function withIntervalTeam(plugin: VaultCrewsPlugin, intervalMinutes: number): void {
    (plugin as unknown as { teamCache: unknown[] }).teamCache = [
      { id: "heartbeat", name: "Heartbeat", description: "", problem: null, intervalMinutes },
      { id: "manuell", name: "Manuell", description: "", problem: null, intervalMinutes: null },
    ];
  }

  it("startet nur das fällige Intervall-Team, nie beim ersten Takt, und sonst keines", async () => {
    vi.mocked(executeRun).mockReturnValue(new Promise<RunResult>(() => { /* bleibt aktiv */ }));
    const plugin = makePlugin();
    await plugin.onload();
    withIntervalTeam(plugin, 10);
    const MIN = 60_000;

    plugin.heartbeatTick(0);
    expect(vi.mocked(executeRun)).not.toHaveBeenCalled();
    plugin.heartbeatTick(9 * MIN);
    expect(vi.mocked(executeRun)).not.toHaveBeenCalled();
    plugin.heartbeatTick(10 * MIN);
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(executeRun)).toHaveBeenCalledTimes(1);
  });

  it("lässt einen Takt still ausfallen, solange ein Lauf aktiv ist (keine Notice)", async () => {
    vi.mocked(executeRun).mockReturnValue(new Promise<RunResult>(() => { /* bleibt aktiv */ }));
    const plugin = makePlugin();
    await plugin.onload();
    withIntervalTeam(plugin, 5);
    void plugin.runCrew("manuell");
    await Promise.resolve();
    await Promise.resolve();
    Notice.instances.length = 0;
    plugin.heartbeatTick(0);
    plugin.heartbeatTick(5 * 60_000);
    expect(vi.mocked(executeRun)).toHaveBeenCalledTimes(1);
    expect(Notice.instances).toHaveLength(0);
  });
});

// „Modell des letzten Laufs“: der Lauf nennt je llm-Task sein Modell, main.ts merkt es je Crew (data.json) und reicht es dem Panel durch.
describe("VaultCrewsPlugin — Modell des letzten Laufs", () => {
  const team = { id: "t", name: "T", description: "", problem: null, intervalMinutes: null, agents: [] };
  const withTeam = (plugin: VaultCrewsPlugin): void => {
    (plugin as unknown as { teamCache: unknown[] }).teamCache = [team];
  };
  const finish = (plugin: VaultCrewsPlugin, result: RunResult): void => {
    (plugin as unknown as { onRunFinished(id: string, r: RunResult): void }).onRunFinished("t", result);
  };
  const loadedWith = async (lastRuns: unknown): Promise<VaultCrewsPlugin> => {
    const plugin = makePlugin();
    (plugin as unknown as { loadData(): Promise<unknown> }).loadData = () => Promise.resolve({ lastRuns });
    await plugin.loadSettings();
    withTeam(plugin);
    return plugin;
  };

  it("onRunFinished merkt die Modelle des Laufs, und getTeams reicht sie dem Panel", async () => {
    const plugin = makePlugin();
    await plugin.onload();
    withTeam(plugin);
    finish(plugin, { ...okResult(), models: [{ taskId: "analyse", model: "gross-27b" }] });
    expect(plugin.getTeams()[0]?.lastRun?.models).toEqual([{ taskId: "analyse", model: "gross-27b" }]);
  });

  it("ein Alt-Eintrag ohne Feld bleibt gültig und trägt keine Modelle", async () => {
    const plugin = await loadedWith({ t: { status: "ok", when: 1_700_000_000_000, runId: "r0" } });
    const last = plugin.getTeams()[0]?.lastRun;
    expect(last?.status).toBe("ok");
    expect(last?.models).toBeUndefined();
  });

  it("eine Fremdform im Feld bricht die Anzeige nicht: kaputte Einträge fallen weg, gültige bleiben", async () => {
    const plugin = await loadedWith({
      t: { status: "ok", when: 1_700_000_000_000, runId: "r0", models: [null, "x", { taskId: 1, model: "a" }, { taskId: "b", model: "" }, { taskId: "c" }, { taskId: "analyse", model: "gross-27b" }] },
      u: { status: "ok", when: 1_700_000_000_000, runId: "r1", models: "kaputt" },
    });
    expect(plugin.getTeams()[0]?.lastRun?.models).toEqual([{ taskId: "analyse", model: "gross-27b" }]);
    (plugin as unknown as { teamCache: unknown[] }).teamCache = [{ ...team, id: "u" }];
    expect(plugin.getTeams()[0]?.lastRun?.models).toBeUndefined();
  });
});

describe("Rückgängig für verschobene Notizen", () => {
  const RUN = "r-undo";
  interface UndoPlugin {
    vault: InMemoryVaultPort;
    snapshot: FakeSnapshotStore;
    lastRuns: Record<string, unknown>;
    startUndo(): Promise<void>;
    performUndo(runId: string, teamId: string, plan: UndoPlan): Promise<void>;
  }
  async function undoPlugin(): Promise<UndoPlugin> {
    const plugin = makePlugin();
    await plugin.onload();
    const p = plugin as unknown as UndoPlugin;
    p.vault = new InMemoryVaultPort();
    p.snapshot = new FakeSnapshotStore();
    p.lastRuns = { team: { status: "ok", when: 1, runId: RUN, undoable: true } };
    return p;
  }
  const plan = (over: Partial<UndoPlan>): UndoPlan => ({ moves: [], restores: [], deletes: [], conflicts: [], skipped: [], unrestored: [], unrestoredWhy: {}, ...over });

  it("performUndo: rename läuft vor modify, danach liegt der Vorab-Inhalt am alten Pfad", async () => {
    const p = await undoPlugin();
    await p.vault.create("Ziel/a.md", "NEU");
    await p.vault.mkdir("Inbox");
    const order: string[] = [];
    const rename = p.vault.rename.bind(p.vault);
    const modify = p.vault.modify.bind(p.vault);
    p.vault.rename = async (from, to) => { order.push(`rename:${from}->${to}`); await rename(from, to); };
    p.vault.modify = async (path, content) => { order.push(`modify:${path}`); await modify(path, content); };

    await p.performUndo(RUN, "team", plan({ moves: [{ from: "Ziel/a.md", to: "Inbox/a.md" }], restores: [{ path: "Inbox/a.md", content: "ALT" }] }));

    expect(order).toEqual(["rename:Ziel/a.md->Inbox/a.md", "modify:Inbox/a.md"]);
    expect(await p.vault.exists("Ziel/a.md")).toBe(false);
    expect(await p.vault.read("Inbox/a.md")).toBe("ALT");
    expect(String(Notice.instances.at(-1)?.message)).toBe("Undo complete — restored 1 file(s) to the state before the run.");
  });

  it("performUndo: die Notice nennt die Zahl der übersprungenen Einträge", async () => {
    const p = await undoPlugin();
    await p.performUndo(RUN, "team", plan({ skipped: ["Ziel/a.md", "Ziel/b.md"], conflicts: ["Ziel/a.md", "Ziel/b.md"] }));
    expect(String(Notice.instances.at(-1)?.message)).toBe("Undo complete — restored 0 file(s); 2 moved note(s) were left where they are.");
  });

  it("performUndo: scheitert rename, meldet die Notice den Fehler und der Snapshot bleibt", async () => {
    const p = await undoPlugin();
    await p.snapshot.captureMove(RUN, "team", 0, "Inbox/a.md", "Ziel/a.md");
    await p.performUndo(RUN, "team", plan({ moves: [{ from: "Ziel/a.md", to: "Inbox/a.md" }] }));
    expect(String(Notice.instances.at(-1)?.message)).toBe("Undo did not finish — some notes may already be restored; the run stays undoable, try again.");
    expect(await p.snapshot.load(RUN)).not.toBeNull();
  });

  type FakeModal = { contentEl: { children: { className: string; tagName: string; textContent: string; children: { __component: { clickCB?: () => void } }[] }[] } };
  let answered: unknown;
  /** Wartet auf den nächsten, noch unbeantworteten Dialog und klickt Bestätigen (true) bzw. Abbrechen (false); gibt die Textzeilen zurück. */
  async function answerDialog(accept: boolean): Promise<string[]> {
    await vi.waitFor(() => { expect(Modal.__last).toBeTruthy(); expect(Modal.__last).not.toBe(answered); });
    const modal = Modal.__last as unknown as FakeModal;
    answered = modal;
    const text = modal.contentEl.children.filter((c) => c.tagName === "P").map((c) => c.textContent);
    modal.contentEl.children.find((c) => c.className === "modal-button-container")?.children[accept ? 1 : 0]?.__component.clickCB?.();
    return text;
  }
  async function markRunLog(p: UndoPlugin): Promise<string> {
    const path = `${(p as unknown as { settings: { crewRoot: string } }).settings.crewRoot}/runs/${RUN}/run.md`;
    await p.vault.mkdir(path.slice(0, path.lastIndexOf("/")));
    await p.vault.create(path, "# Lauf");
    return path;
  }

  it("performUndo: bleibt ein Eintrag mit Vorab-Abbild unwiederhergestellt und lehnt der Nutzer das Verwerfen ab, bleiben Snapshot und rückgängig-Flag", async () => {
    const p = await undoPlugin();
    await p.snapshot.captureMove(RUN, "team", 0, "Inbox/a.md", "Ziel/a.md");
    (Modal as unknown as { __last: unknown }).__last = undefined;
    const done = p.performUndo(RUN, "team", plan({ skipped: ["Ziel/a.md"], conflicts: ["Ziel/a.md"], unrestored: ["Ziel/a.md"], unrestoredWhy: { "Ziel/a.md": "gone" } }));
    await answerDialog(false);
    await done;
    expect(await p.snapshot.load(RUN)).not.toBeNull();
    expect((p.lastRuns.team as { undoable: boolean }).undoable).toBe(true);
    expect(String(Notice.instances.at(-1)?.message)).toBe("Undo partly done — restored 0 file(s); 1 note(s) could not be restored, the run stays undoable.");
  });

  it("performUndo: zweiter Dialog nennt je Pfad den Grund und den Verlust der Vorab-Abbilder; Zustimmen verwirft den Lauf", async () => {
    const p = await undoPlugin();
    const logPath = await markRunLog(p);
    await p.snapshot.captureMove(RUN, "team", 0, "Inbox/a.md", "Ziel/a.md");
    (Modal as unknown as { __last: unknown }).__last = undefined;
    const done = p.performUndo(RUN, "team", plan({
      skipped: ["Ziel/a.md", "Ziel/b.md"], conflicts: ["Ziel/a.md", "Ziel/b.md"], unrestored: ["Ziel/a.md", "Ziel/b.md"],
      unrestoredWhy: { "Ziel/a.md": "gone", "Ziel/b.md": "taken" },
    }));
    const text = await answerDialog(true);
    await done;
    expect(text.join("\n")).toContain("Ziel/a.md — no longer exists");
    expect(text.join("\n")).toContain("Ziel/b.md — old path is taken, restorable once it is cleared");
    expect(text.join("\n")).toContain("pre-run copies");
    expect(await p.snapshot.load(RUN)).toBeNull();
    expect((p.lastRuns.team as { undoable: boolean }).undoable).toBe(false);
    expect(await p.vault.read(logPath)).toContain("This run was undone.");
    expect(String(Notice.instances.at(-1)?.message)).toBe("Run discarded — restored 0 file(s); 2 note(s) could not be restored, their pre-run copies are gone.");
    // Wer verwirft, bekommt keine Notice, die „stays undoable“ behauptet.
    expect(Notice.instances.map((n) => String(n.message)).some((m) => m.includes("stays undoable"))).toBe(false);
  });

  /** Manifest mit einem Eintrag, dessen rename nach captureMove scheiterte (oder dessen Zug ein erster Versuch schon ausführte). */
  async function movedEntry(p: UndoPlugin, postHash: string | null): Promise<void> {
    p.snapshot.manifests.set(RUN, { runId: RUN, teamId: "team", createdAt: 0, entries: [{ path: "Ziel/a.md", movedFrom: "Inbox/a.md", existedBefore: true, preHash: fnv1a("ALT"), postHash, blob: "0.snapshot" }] });
    p.snapshot.blobs.set(`${RUN}/0.snapshot`, "ALT");
  }
  /** Bestätigt den ersten Dialog; `discard` (true/false) beantwortet zusätzlich den zweiten („Lauf verwerfen“), `undefined` erwartet keinen. */
  async function confirmUndo(p: UndoPlugin, discard?: boolean): Promise<void> {
    (Modal as unknown as { __last: unknown }).__last = undefined;
    const done = p.startUndo();
    await answerDialog(true);
    if (discard !== undefined) await answerDialog(discard);
    await done;
  }

  it("Rückgängig: rename scheiterte nach captureMove, die Änderung der Crew am alten Pfad weicht dem Vorab-Abbild", async () => {
    const p = await undoPlugin();
    await movedEntry(p, null);
    await p.vault.create("Inbox/a.md", "ALT\nvon der Crew angehängt");
    await confirmUndo(p);
    expect(await p.vault.read("Inbox/a.md")).toBe("ALT");
    expect(await p.snapshot.load(RUN)).toBeNull();
    expect(String(Notice.instances.at(-1)?.message)).toBe("Undo complete — restored 1 file(s) to the state before the run.");
  });

  it("Rückgängig: Notiz schon zurückgeschoben, der Restore fehlte — der zweite Versuch stellt den Blob her", async () => {
    const p = await undoPlugin();
    await movedEntry(p, fnv1a("NEU"));
    await p.vault.create("Inbox/a.md", "NEU");
    await confirmUndo(p);
    expect(await p.vault.read("Inbox/a.md")).toBe("ALT");
    expect(await p.snapshot.load(RUN)).toBeNull();
  });

  it("Rückgängig: fremd belegter alter Pfad bleibt unberührt, der Lauf bleibt rückgängig-fähig", async () => {
    const p = await undoPlugin();
    await movedEntry(p, fnv1a("NEU"));
    await p.vault.create("Inbox/a.md", "fremd");
    await confirmUndo(p, false);
    expect(await p.vault.read("Inbox/a.md")).toBe("fremd");
    expect(await p.snapshot.load(RUN)).not.toBeNull();
    expect((p.lastRuns.team as { undoable: boolean }).undoable).toBe(true);
    expect(String(Notice.instances.at(-1)?.message)).toBe("Undo partly done — restored 0 file(s); 1 note(s) could not be restored, the run stays undoable.");
  });

  it("Rückgängig: Notiz an beiden Pfaden weg — erneutes Rückgängig fragt nur noch nach dem Verwerfen, Zustimmen beendet den Lauf", async () => {
    const p = await undoPlugin();
    await movedEntry(p, null);
    await confirmUndo(p, false); // erster Versuch: abgelehnt, Lauf bleibt
    expect(await p.snapshot.load(RUN)).not.toBeNull();
    await confirmUndo(p, true);  // später erneut: derselbe zweite Dialog
    expect(await p.snapshot.load(RUN)).toBeNull();
    expect((p.lastRuns.team as { undoable: boolean }).undoable).toBe(false);
    await expect(p.startUndo()).resolves.toBeUndefined();
    expect(String(Notice.instances.at(-1)?.message)).toBe("No previous run yet — run a crew first.");
  });

  it("Rückgängig: Notiz noch am neuen Pfad, alter Pfad belegt — der zweite Dialog nennt „alter Pfad belegt“", async () => {
    const p = await undoPlugin();
    await movedEntry(p, fnv1a("NEU"));
    await p.vault.create("Ziel/a.md", "NEU");
    await p.vault.create("Inbox/a.md", "fremd");
    (Modal as unknown as { __last: unknown }).__last = undefined;
    const done = p.startUndo();
    await answerDialog(true);
    const text = await answerDialog(false);
    await done;
    expect(text.join("\n")).toContain("Ziel/a.md — old path is taken, restorable once it is cleared");
    expect(await p.vault.read("Ziel/a.md")).toBe("NEU");
  });

  it("Dialog: nennt die Rückverschiebungen und die übersprungenen Notizen", async () => {
    const p = await undoPlugin();
    await p.snapshot.captureMove(RUN, "team", 0, "Inbox/a.md", "Ziel/a.md");
    await p.snapshot.captureMove(RUN, "team", 0, "Inbox/b.md", "Ziel/b.md");
    await p.snapshot.finalize(RUN, { "Ziel/a.md": fnv1a("A"), "Ziel/b.md": fnv1a("B") }, 15, 0);
    await p.vault.create("Ziel/a.md", "A");
    await p.vault.create("Ziel/b.md", "B");
    await p.vault.create("Inbox/b.md", "fremd"); // alter Pfad wieder belegt

    (Modal as unknown as { __last: unknown }).__last = undefined;
    const done = p.startUndo();
    await vi.waitFor(() => expect(Modal.__last).toBeTruthy());
    const modal = Modal.__last as unknown as { contentEl: { children: { tagName: string; textContent: string }[] } };
    const text = modal.contentEl.children.filter((c) => c.tagName === "P").map((c) => c.textContent);
    expect(text).toContain("Moved back: Ziel/a.md → Inbox/a.md");
    expect(text.some((l) => l.startsWith("1 moved note(s) stay where they are") && l.endsWith("Ziel/b.md"))).toBe(true);
    // Der übersprungene Eintrag zählt nicht zusätzlich als „nach dem Lauf geändert“.
    expect(text.some((l) => l.includes("changed after the run"))).toBe(false);
    (modal as unknown as { onClose(): void }).onClose();
    await done;
  });
});
