// Waechter fuer den deklarativen Settings-Pfad (`getSettingDefinitions()`, Obsidian >= 1.13).
//
// Warum das eigene Tests braucht: ab 1.13 rendert der Host aus den Definitionen und ruft
// `display()` NIE. Der Fallback-Walker fuer aeltere Versionen zeichnet dieselbe Struktur —
// zwei Renderer, eine Wahrheit. Faellt eine Zeile in genau einem der beiden Pfade aus, sieht
// man das lokal nicht: unter 1.12 ist sie da, unter 1.13 fehlt sie, und nichts wird rot.
//
// Die drei Faelle unten sind keine erfundenen Randfaelle, sondern die in REGISTRY.md
// dokumentierten Funde aus den 15 vorangegangenen Migrationen im Oekosystem.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeApp } from "../__mocks__/obsidian";
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

function makeTab(host: SettingsHost = makeFakeHost()): SettingsTab {
  return new SettingsTab({ app: makeFakeApp() } as unknown as Plugin, host);
}

/** Die Definitionen sind eine Baumstruktur aus Gruppen und Zeilen; fuer die Pruefung
 *  interessiert nur, welche Zeilen unten ankommen. */
type AnyItem = {
  name?: string;
  desc?: string;
  heading?: string;
  visible?: boolean;
  control?: { type: string; key: string };
  render?: unknown;
  items?: AnyItem[];
};

function flatten(items: AnyItem[]): AnyItem[] {
  return items.flatMap((it) => [it, ...flatten(it.items ?? [])]);
}

describe("SettingsTab.getSettingDefinitions()", () => {
  it("liefert die vier Gruppen der Spec als Ueberschriften", () => {
    const defs = makeTab().getSettingDefinitions() as unknown as AnyItem[];

    const headings = flatten(defs).map((it) => it.heading).filter(Boolean);
    expect(headings).toHaveLength(4);
  });

  it("gibt jeder Zeile entweder einen Regler oder einen eigenen Renderer", () => {
    // REGISTRY-Fund (yijing-oracle 2026-08-16): eine Definition OHNE Control ueberspringt
    // der native 1.13-Renderer stillschweigend, waehrend der Fallback-Walker sie zeichnet.
    // Eine reine Text-/Hinweiszeile verschwindet dadurch ab 1.13 spurlos. Merksatz: eine
    // Zeile ohne Regler braucht im deklarativen Modell trotzdem einen Renderer.
    const defs = makeTab().getSettingDefinitions() as unknown as AnyItem[];

    const stumm = flatten(defs)
      .filter((it) => it.heading === undefined && it.items === undefined)
      .filter((it) => it.control === undefined && it.render === undefined)
      .map((it) => it.name ?? it.desc ?? "(namenlos)");

    expect(stumm, `Zeilen ohne Regler und ohne Renderer: ${stumm.join(", ")}`).toEqual([]);
  });

  it("laesst eine bedingte Zeile weg, statt sie per visible zu verstecken", () => {
    // REGISTRY-Fund (obsidian-paperize 2026-08-14): `visible: false` wertet der native
    // 1.13.7-Renderer NICHT aus — die Zeile bleibt stehen. Bedingte Zeilen gehoeren
    // weggelassen; das wirkt in beiden Pfaden, weil getSettingDefinitions() bei jedem
    // Rebuild neu ausgewertet wird.
    const defs = makeTab().getSettingDefinitions() as unknown as AnyItem[];

    const versteckt = flatten(defs).filter((it) => it.visible === false);

    expect(versteckt).toEqual([]);
  });

  it("verdrahtet jeden deklarierten Regler mit den echten Settings", () => {
    // Faengt Tippfehler im `key`: ein unbekannter Schluessel greift zur Laufzeit stumm ins
    // Leere — die Zeile erscheint, zeigt aber nichts an und speichert nichts.
    const host = makeFakeHost();
    const tab = makeTab(host);
    const controls = flatten(tab.getSettingDefinitions() as unknown as AnyItem[])
      .map((it) => it.control)
      .filter((c): c is { type: string; key: string } => c !== undefined);

    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(tab.getControlValue(c.key), `getControlValue kennt "${c.key}" nicht`).toBeDefined();
    }
  });

  it("schreibt einen geaenderten Regler-Wert in die Settings zurueck", () => {
    const host = makeFakeHost();
    const tab = makeTab(host);

    tab.setControlValue("crewRoot", "_teams");

    expect(host.settings.crewRoot).toBe("_teams");
    expect(host.saveSettings).toHaveBeenCalled();
  });
});
