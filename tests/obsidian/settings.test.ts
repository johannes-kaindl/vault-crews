// Smoke-Tests der SettingsTab (Mock-Grenze = Port-Grenze, Spec §8): kein Deep-Mocking
// von `app`, nur „richtige Setting-API-Aufrufe + SettingsHost-Vertrag erfüllt".
// SettingsHost entkoppelt SettingsTab bewusst von main.ts (Task 16b) — der Fake-Host
// hier steht stellvertretend für das spätere Plugin-Objekt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ButtonComponent, TextComponent, ToggleComponent, makeFakeApp, Notice } from "../__mocks__/obsidian";
import type { Plugin } from "obsidian";
import { registerI18n } from "../../src/i18n/strings";
import { setLang } from "../../src/vendor/kit/i18n";
import {
  DEFAULT_SETTINGS,
  SettingsTab,
  type PluginSettings,
  type SettingsHost,
} from "../../src/obsidian/settings";

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
    testConnection: vi.fn().mockResolvedValue({ ok: true, models: ["m1"] }),
    ...overrides,
  };
}

/** Minimaler Plugin-Fake: SettingsTab liest nach `super(plugin.app, plugin)` nie wieder
 *  von `plugin` selbst (nur `this.app`, gesetzt von PluginSettingTab, und `this.host`)
 *  — ein Objekt mit `.app` genügt daher, ohne die echte `Plugin`-Basisklasse zu bauen. */
function makeFakePlugin(): Plugin {
  return { app: makeFakeApp() } as unknown as Plugin;
}

/** Fängt jeden addButton()-Klick-Handler in Erstellungsreihenfolge ab, unabhängig
 *  davon, welche interne Setting-Instanz ihn registriert hat (die SettingsTab hält
 *  keine Referenzen auf ihre Setting()-Aufrufe — das ist Absicht: sie ist ein reiner
 *  Renderer). */
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

/** Fängt jeden addText()/addTextArea()-onChange-Handler ab (TextAreaComponent erbt
 *  onChange unverändert von TextComponent im Mock, daher genügt EIN Spy für beide). */
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

    // Jede `new Setting(containerEl)` legt über containerEl.createDiv(...) ein Kind an
    // (Mock-Semantik) — 4 Überschriften + 12 Felder (5 Connection, 3 Crews, 3 Safety inkl.
    // Undo-Verlauf-Tiefe, 4 Advanced abzüglich der Überschriften) = 16 Setting-Instanzen.
    expect(tab.containerEl.children.length).toBe(16);
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

  it("the test-connection button tries endpoints in order and stops at the first success", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost({
      settings: { ...DEFAULT_SETTINGS, endpoints: ["http://a", "http://b"] },
      testConnection: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, models: [] })
        .mockResolvedValueOnce({ ok: true, models: ["m1", "m2"] }),
    });
    const clicks = captureButtonClicks();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // Erster Button in Erstellungsreihenfolge = „Test connection" (Connection-Gruppe
    // wird zuerst gerendert).
    await clicks[0]?.();

    expect(host.testConnection).toHaveBeenNthCalledWith(1, "http://a");
    expect(host.testConnection).toHaveBeenNthCalledWith(2, "http://b");
    expect(host.testConnection).toHaveBeenCalledTimes(2);
    expect(Notice.instances).toHaveLength(1);
    // Erfolgs-Notice nennt die Modell-Ids (§6.4 „Default-Modell aus /v1/models"), nicht
    // mehr den Endpoint — der Nutzer soll die exakte Id ins Default-model-Feld kopieren.
    expect(String(Notice.instances[0]?.message)).toContain("m1, m2");
  });

  it("the test-connection button shows a failure notice when no endpoint responds", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost({
      settings: { ...DEFAULT_SETTINGS, endpoints: ["http://a"] },
      testConnection: vi.fn().mockResolvedValue({ ok: false, models: [] }),
    });
    const clicks = captureButtonClicks();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    await clicks[0]?.();

    expect(host.testConnection).toHaveBeenCalledTimes(1);
    expect(Notice.instances).toHaveLength(1);
    expect(String(Notice.instances[0]?.message)).toBe(
      "Connection failed — is LM Studio running?",
    );
  });

  it("the install-examples button never calls saveSettings/testConnection (host has no install hook)", () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const clicks = captureButtonClicks();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // Zweiter Button in Erstellungsreihenfolge = „Install example crews" (Crews-Gruppe).
    clicks[1]?.();

    expect(Notice.instances).toHaveLength(1);
    expect(host.saveSettings).not.toHaveBeenCalled();
    expect(host.testConnection).not.toHaveBeenCalled();
  });

  it("editing the crew-root text field updates host.settings and persists", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const changes = captureTextChanges();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // Erstellungsreihenfolge der Text/TextArea-Felder: endpoints, deniedEndpoints,
    // defaultModel (Connection) · crewRoot (Crews) → Index 3.
    await changes[3]?.("custom-root");

    expect(host.settings.crewRoot).toBe("custom-root");
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("editing the max-writes field parses to a number and ignores garbage input", async () => {
    const plugin = makeFakePlugin();
    const host = makeFakeHost();
    const changes = captureTextChanges();
    const tab = new SettingsTab(plugin, host);
    tab.display();

    // Index 4 = maxWrites (Safety-Gruppe, erstes addText nach crewRoot).
    await changes[4]?.("25");
    expect(host.settings.maxWrites).toBe(25);

    await changes[4]?.("not-a-number");
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
