// Smoke-Tests der SettingsTab (Mock-Grenze = Port-Grenze, Spec §8): kein Deep-Mocking
// von `app`, nur „richtige Setting-API-Aufrufe + SettingsHost-Vertrag erfüllt".
// SettingsHost entkoppelt SettingsTab bewusst von main.ts (Task 16b) — der Fake-Host
// hier steht stellvertretend für das spätere Plugin-Objekt. Die reine Editor-Logik
// (applyEndpointEdit etc.) ist separat in endpoint-editor-model.test.ts abgedeckt; hier
// wird nur die Verdrahtung (blur → commit, Preset, Trash, Modell-Laden) geprüft.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ButtonComponent,
  ExtraButtonComponent,
  TextComponent,
  ToggleComponent,
  makeFakeApp,
  Notice,
} from "../__mocks__/obsidian";
import type { Plugin } from "obsidian";
import { registerI18n } from "../../src/i18n/strings";
import { setLang } from "../../src/vendor/kit/i18n";
import {
  DEFAULT_SETTINGS,
  SettingsTab,
  type PluginSettings,
  type SettingsHost,
} from "../../src/obsidian/settings";
import type { EndpointStatus } from "../../src/vendor/kit/endpoint_diagnostics";

const OK_STATUS: EndpointStatus = { reachable: true, kind: "ok", klartext: "Connected" };

beforeEach(() => {
  registerI18n();
  setLang("en");
  Notice.instances.length = 0;
});
afterEach(() => {
  setLang("en");
  vi.restoreAllMocks();
});

function makeFakeHost(overrides: Partial<SettingsHost> = {}): SettingsHost {
  const settings: PluginSettings = { ...DEFAULT_SETTINGS };
  return {
    settings,
    saveSettings: vi.fn().mockResolvedValue(undefined),
    probeEndpoint: vi.fn().mockResolvedValue(OK_STATUS),
    loadModels: vi.fn().mockResolvedValue({ endpoint: "http://localhost:1234", models: ["m1", "m2"] }),
    ...overrides,
  };
}

/** Minimaler Plugin-Fake: SettingsTab liest nach `super(plugin.app, plugin)` nie wieder
 *  von `plugin` selbst (nur `this.app`, gesetzt von PluginSettingTab, und `this.host`). */
function makeFakePlugin(): Plugin {
  return { app: makeFakeApp() } as unknown as Plugin;
}

/** Fängt jeden addButton()-Klick-Handler in Erstellungsreihenfolge ab. */
function captureButtonClicks(): Array<() => unknown> {
  const handlers: Array<() => unknown> = [];
  vi.spyOn(ButtonComponent.prototype, "onClick").mockImplementation(function (
    this: InstanceType<typeof ButtonComponent>,
    cb: () => unknown,
  ) {
    this.clickCB = cb;
    handlers.push(cb);
    return this;
  });
  return handlers;
}

/** Fängt jeden addExtraButton()-Klick-Handler (Mülleimer) in Erstellungsreihenfolge ab. */
function captureExtraButtonClicks(): Array<() => unknown> {
  const handlers: Array<() => unknown> = [];
  vi.spyOn(ExtraButtonComponent.prototype, "onClick").mockImplementation(function (
    this: InstanceType<typeof ExtraButtonComponent>,
    cb: () => unknown,
  ) {
    this.clickCB = cb;
    handlers.push(cb);
    return this;
  });
  return handlers;
}

/** Fängt jeden addText()-onChange-Handler ab (crewRoot/maxWrites/… — NICHT die
 *  blur-basierten Endpoint-Zeilen, die editieren über inputEl-blur). */
function captureTextChanges(): Array<(v: string) => unknown> {
  const handlers: Array<(v: string) => unknown> = [];
  vi.spyOn(TextComponent.prototype, "onChange").mockImplementation(function (
    this: InstanceType<typeof TextComponent>,
    cb: (v: string) => unknown,
  ) {
    this.onChangeCB = cb;
    handlers.push(cb);
    return this;
  });
  return handlers;
}

/** Sammelt jede erzeugte TextComponent in Erstellungsreihenfolge (via setValue-Spy),
 *  um ihre `inputEl` für blur-getriebene Endpoint-Edits zu erreichen. */
function captureTexts(): TextComponent[] {
  const items: TextComponent[] = [];
  vi.spyOn(TextComponent.prototype, "setValue").mockImplementation(function (
    this: TextComponent & { _value: string },
    v: string,
  ) {
    this._value = String(v ?? "");
    if (!items.includes(this)) items.push(this);
    return this;
  });
  return items;
}

describe("DEFAULT_SETTINGS", () => {
  it("matches the exact spec'd defaults (guards against value drift)", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      endpoints: ["http://localhost:1234/v1"],
      deniedEndpoints: ["http://localhost:8080", "http://127.0.0.1:8080"],
      defaultModel: "",
      crewRoot: "_crews",
      maxWrites: 10,
      wallClockMinutes: 10,
      callTimeoutS: 300,
      stallTimeoutS: 60,
      undoHistoryDepth: 15,
      verboseLogging: false,
    });
  });
});

describe("SettingsTab.display()", () => {
  it("renders all four groups without throwing and creates Setting elements", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const tab = new SettingsTab(plugin, host);

    expect(() => tab.display()).not.toThrow();

    // Jede `new Setting(containerEl)` legt über containerEl.createDiv(...) ein Kind an.
    // Connection: 1 Heading + Endpoints(1 Zeile + 1 Adder + 1 Aktionszeile) + 1 Modell +
    // Denied(2 Zeilen + 1 Adder) = 8 · Crews 3 · Safety 4 · Advanced 4 = 19.
    expect(tab.containerEl.children.length).toBe(19);
  });

  it("re-rendering (repeated display() calls) clears the previous content first", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const tab = new SettingsTab(plugin, host);

    tab.display();
    const firstCount = tab.containerEl.children.length;
    tab.display();

    expect(tab.containerEl.children.length).toBe(firstCount);
  });
});

describe("SettingsTab — endpoint row editor", () => {
  it("editing an endpoint row on blur updates host.settings and persists", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost({ settings: { ...DEFAULT_SETTINGS, endpoints: ["http://a:1"] } });
    const texts = captureTexts();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // texts[0] = erste Endpoint-Zeile (Connection wird zuerst gerendert).
    texts[0]?.setValue("http://b:2");
    texts[0]?.inputEl.dispatchEvent({ type: "blur" });

    expect(host.settings.endpoints).toEqual(["http://b:2"]);
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("an unchanged endpoint row does not re-save on blur (no-op guard)", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost({ settings: { ...DEFAULT_SETTINGS, endpoints: ["http://a:1"] } });
    const texts = captureTexts();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    texts[0]?.inputEl.dispatchEvent({ type: "blur" }); // Wert unverändert

    expect(host.saveSettings).not.toHaveBeenCalled();
  });

  it("the trash button removes its endpoint row and persists", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost({ settings: { ...DEFAULT_SETTINGS, endpoints: ["http://a:1", "http://b:2"] } });
    const trash = captureExtraButtonClicks();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // trash[0] = Mülleimer der ERSTEN Endpoint-Zeile.
    trash[0]?.();

    expect(host.settings.endpoints).toEqual(["http://b:2"]);
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("a preset button appends its endpoint when not already present", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost({ settings: { ...DEFAULT_SETTINGS, endpoints: [] } });
    const clicks = captureButtonClicks();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // clicks[0] = erstes Preset (LM Studio) der Endpoint-Aktionszeile.
    clicks[0]?.();

    expect(host.settings.endpoints).toEqual(["http://localhost:1234"]);
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("probes each configured endpoint on render (per-row status)", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost({ settings: { ...DEFAULT_SETTINGS, endpoints: ["http://a:1", "http://b:2"] } });
    const tab = new SettingsTab(plugin, host);
    tab.display();

    expect(host.probeEndpoint).toHaveBeenCalledWith("http://a:1");
    expect(host.probeEndpoint).toHaveBeenCalledWith("http://b:2");
  });
});

describe("SettingsTab — default model field", () => {
  it("the load-models button loads models and shows no notice when an endpoint responds", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const clicks = captureButtonClicks();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // Button-Reihenfolge Connection: 2 Presets + 1 „Verbindungen prüfen" + 1 „Modelle laden".
    await clicks[3]?.();

    expect(host.loadModels).toHaveBeenCalledTimes(1);
    expect(Notice.instances).toHaveLength(0);
  });

  it("the load-models button warns via a notice when no endpoint is reachable", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost({
      loadModels: vi.fn().mockResolvedValue({ endpoint: null, models: [] }),
    });
    const clicks = captureButtonClicks();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    await clicks[3]?.();

    expect(Notice.instances).toHaveLength(1);
    expect(String(Notice.instances[0]?.message)).toBe(
      "No reachable endpoint — enter the model manually.",
    );
  });
});

describe("SettingsTab — other groups", () => {
  it("the install-examples button never calls saveSettings/probe (host has no install hook)", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const clicks = captureButtonClicks();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // Button-Index 4 = „Install example crews" (Crews-Gruppe, nach den 4 Connection-Buttons).
    clicks[4]?.();

    expect(Notice.instances).toHaveLength(1);
    // Der Install-Button meldet nur „nutze den Command" — er persistiert nichts.
    expect(host.saveSettings).not.toHaveBeenCalled();
  });

  it("editing the crew-root text field updates host.settings and persists", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const changes = captureTextChanges();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // Endpoint-/Denied-Zeilen editieren über blur (kein onChange). Die onChange-Felder in
    // Erstellungsreihenfolge: [defaultModel(freetext), crewRoot, maxWrites, wallClock,
    // undoDepth, callTimeout, stallTimeout] → crewRoot = Index 1.
    await changes[1]?.("custom-root");

    expect(host.settings.crewRoot).toBe("custom-root");
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("editing the max-writes field parses to a number and ignores garbage input", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const changes = captureTextChanges();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // onChange-Index 2 = maxWrites (nach defaultModel-Freitext[0] und crewRoot[1]).
    await changes[2]?.("25");
    expect(host.settings.maxWrites).toBe(25);

    await changes[2]?.("not-a-number");
    expect(host.settings.maxWrites).toBe(25); // Fallback: letzter gültiger Wert bleibt erhalten
  });

  it("toggling verbose logging updates host.settings and persists", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const toggles: Array<(v: boolean) => unknown> = [];
    vi.spyOn(ToggleComponent.prototype, "onChange").mockImplementation(function (
      this: InstanceType<typeof ToggleComponent>,
      cb: (v: boolean) => unknown,
    ) {
      this.onChangeCB = cb;
      toggles.push(cb);
      return this;
    });
    const tab = new SettingsTab(plugin, host);
    tab.display();

    expect(toggles).toHaveLength(1);
    await toggles[0]?.(true);

    expect(host.settings.verboseLogging).toBe(true);
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });
});
