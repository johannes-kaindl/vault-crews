// Smoke-Tests der SettingsTab (Mock-Grenze = Port-Grenze, Spec §8): kein Deep-Mocking
// von `app`, nur „richtige Setting-API-Aufrufe + SettingsHost-Vertrag erfüllt".
// SettingsHost entkoppelt SettingsTab bewusst von main.ts — der Fake-Host hier steht
// stellvertretend für das Plugin-Objekt.
//
// Seit 2026-08-14 kommt der Endpunkt-Zeilen-Editor vollständig aus dem Kit
// (`buildEndpointList`). Sein INNENLEBEN — blur-Commit, Adder-Zeile, Trash, Presets,
// Modell-Dropdown — ist dort getestet und wird hier bewusst NICHT nachgetestet; doppelte
// Tests über eine Vendor-Kopie erzeugen nur den Eindruck von Abdeckung. Hier steht, was
// dieses Repo beisteuert: die Verdrahtung, die Sperrliste und die Fähigkeiten-Zeile.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ButtonComponent,
  Setting,
  DropdownComponent,
  ExtraButtonComponent,
  TextAreaComponent,
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
    listModels: vi.fn().mockResolvedValue(["m1", "m2"]),
    resolveActive: vi.fn().mockResolvedValue(null),
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

/** Sammelt Name und Beschreibung jeder erzeugten Setting-Zeile. Der Mock haelt beides in
 *  Feldern statt im DOM — ueber das Element ist der Text also nicht zu finden. */
function captureSettingTexts(): string[] {
  const seen: string[] = [];
  vi.spyOn(Setting.prototype, "setName").mockImplementation(function (this: any, name: any) {
    seen.push(String(name ?? ""));
    this.nameValue = String(name ?? "");
    return this;
  });
  vi.spyOn(Setting.prototype, "setDesc").mockImplementation(function (this: any, desc: any) {
    seen.push(String(desc ?? ""));
    this.descValue = String(desc ?? "");
    return this;
  });
  return seen;
}

/** Sammelt jede erzeugte TextAreaComponent (Sperrliste) in Erstellungsreihenfolge. */
function captureTextAreas(): TextAreaComponent[] {
  const items: TextAreaComponent[] = [];
  vi.spyOn(TextAreaComponent.prototype, "setValue").mockImplementation(function (
    this: TextAreaComponent & { _value: string },
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
      endpoints: [{ url: "http://localhost:1234/v1" }],
      deniedEndpoints: ["http://localhost:8080", "http://127.0.0.1:8080"],
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
    // Connection: 1 Heading + Kit-Editor (Beschriftungszeile + 1 Zeile + Adder + Preset-/
    // Prüfzeile) + 1 Sperrliste = 6 · Crews 3 · Safety 4 · Advanced 4 = 17. Die
    // Fähigkeiten-Zeile fehlt hier, weil ohne aufgelösten Endpunkt nichts zu sagen ist.
    expect(tab.containerEl.children.length).toBe(17);
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

describe("SettingsTab — Verdrahtung des Kit-Editors", () => {
  it("reicht die eigenen Endpunkte hinein und Aenderungen zurueck", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    host.settings.endpoints = [{ url: "http://a:1", apiKey: "k", model: "m" }];
    const tab = new SettingsTab(plugin, host);

    expect(() => tab.display()).not.toThrow();
    // Der Editor fragt seine Liste ueber get() ab — sie muss unveraendert ankommen,
    // insbesondere MIT Schluessel und Modell (das war vor dem Umbau nicht speicherbar).
    expect(host.settings.endpoints).toEqual([{ url: "http://a:1", apiKey: "k", model: "m" }]);
  });

  it("probt jede Zeile mit ihrem eigenen Eintrag, nicht mit einer blanken URL", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    host.settings.endpoints = [{ url: "http://a:1", apiKey: "geheim" }];
    const tab = new SettingsTab(plugin, host);

    tab.display();
    await Promise.resolve();

    // Der Schluessel MUSS mitgehen: ein Gateway, das unauthentifiziert 401 antwortet,
    // gaelte sonst als tot und die Zeile bliebe dauerhaft rot.
    expect(host.probeEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://a:1", apiKey: "geheim" }),
    );
  });
});

describe("SettingsTab — Sperrliste", () => {
  it("uebernimmt die Textarea zeilenweise beim Verlassen des Feldes", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    host.settings.deniedEndpoints = ["http://alt:1"];
    const areas = captureTextAreas();
    const tab = new SettingsTab(plugin, host);

    tab.display();
    const area = areas[areas.length - 1];
    expect(area).toBeTruthy();
    (area as unknown as { _value: string })._value = "http://x:1\nhttp://y:2\n\n  http://z:3  ";
    area!.inputEl.dispatchEvent(new Event("blur"));

    // parseEndpointList trimmt, verwirft Leerzeilen und haelt die Reihenfolge.
    expect(host.settings.deniedEndpoints).toEqual(["http://x:1", "http://y:2", "http://z:3"]);
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("speichert nicht, wenn sich nichts geaendert hat", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    host.settings.deniedEndpoints = ["http://alt:1"];
    const areas = captureTextAreas();
    const tab = new SettingsTab(plugin, host);

    tab.display();
    const area = areas[areas.length - 1];
    (area as unknown as { _value: string })._value = "http://alt:1";
    area!.inputEl.dispatchEvent(new Event("blur"));

    expect(host.saveSettings).not.toHaveBeenCalled();
  });
});

describe("SettingsTab — Faehigkeiten des aktiven Modells", () => {
  it("zeigt nichts, solange kein Endpunkt aufgeloest ist", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    host.settings.endpoints = [{ url: "http://a:1", model: "qwen3-8b" }];
    const texts = captureSettingTexts();
    const tab = new SettingsTab(plugin, host);

    tab.display();

    expect(texts.join(" | ")).not.toContain("Reasoning");
  });

  it("beschreibt das Modell der aktiven Zeile, sobald sie aufgeloest ist", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost({ resolveActive: vi.fn().mockResolvedValue("http://a:1") });
    host.settings.endpoints = [{ url: "http://a:1", model: "qwen3-8b" }];
    const texts = captureSettingTexts();
    const tab = new SettingsTab(plugin, host);

    tab.display();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const joined = texts.join(" | ");
    expect(joined).toContain("qwen3-8b");
    // Und zwar als Vermutung beschriftet — die Namens-Heuristik behauptet nie mehr,
    // als der Name hergibt.
    expect(joined).toContain("Reasoning");
  });
});
