// vendored from obsidian-kit@0.106.0, src/obsidian/status-bar-item.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
import { Setting } from "obsidian";
import type { SettingDefinitionRender } from "obsidian";

/** UI-STANDARD §8 „Statusleisten-Eintrag“ (seit 0.85.0): wer in die Statusleiste schreibt, hat einen Schalter in den Einstellungen, Standard **an**
 *  (Entscheidung Johannes, 2026-11-12: ein Update lässt sonst Anzeigen verschwinden, die jemand nutzt). Der Baustein trägt beides:
 *
 *  - `createStatusBarItem(opts)` legt den Eintrag über `plugin.addStatusBarItem()` an, solange der Schalter an ist, hängt ihn beim Ausschalten ab (`remove()`) und legt ihn
 *    beim Einschalten neu an. Der Handle merkt sich Text und Zustand: jeder Aufruf ist gefahrlos, auch wenn der Eintrag gerade aus ist, und der Text steht nach dem
 *    Wiedereinschalten wieder da. Ein wieder angelegter Eintrag steht am Ende der Leiste (Obsidian hängt ihn hinten an), nicht an seiner alten Stelle.
 *  - `buildStatusBarSetting` und `statusBarSettingDefinition` sind die Einstellungszeile „Statusleiste“ mit dem Schalter (Tabs mit `display()` und Tabs mit
 *    `getSettingDefinitions()`). Der Schlüsselname in den Einstellungen vergibt das Plugin (Empfehlung `showStatusBar`); die Zeile kennt nur den Wert und `onChange`.
 *
 *  Verdrahtung: `DEFAULT_SETTINGS.showStatusBar = STATUS_BAR_DEFAULT`, beim Laden `statusBarEnabled(raw.showStatusBar)`, die Zeile ruft in `onChange` den Handle
 *  (`item.setVisible(v)`) und speichert. Was der Eintrag zeigt, bestimmt das Plugin: `item.set(text)` für einen Text, oder `render(el)` für Eigenbau im Element
 *  (Symbol, Kinder, Zustandsklassen); `refresh()` zeichnet nach einer Zustandsänderung neu. Klick, Tastatur und `aria-*` hängt das Plugin in `onCreate(el)`, das bei jedem
 *  neu angelegten Element läuft (ein abgehängtes Element nimmt seine Zuhörer mit).
 *
 *  Zeitweiliges Einblenden (vault-rag zeigt die Leiste während eines Reindex, auch bei ausgeschaltetem Schalter): `const release = item.reveal()`, am Ende `release()`;
 *  mehrere Anlässe zählen mit, der Eintrag verschwindet erst, wenn keiner mehr offen ist und der Schalter aus ist.
 *
 *  Kein CSS: ausgeblendet wird mit Obsidians `hide()`/`show()` und der Klasse `is-hidden` (für Selektoren, die ein Plugin schon darauf hat). */
export const STATUS_BAR_DEFAULT = true;

/** Der Wert eines gespeicherten Schalters: ein Boolean gilt, alles andere (fehlt, `null`, Text) fällt auf `fallback` (Standard: an). */
export function statusBarEnabled(raw: unknown, fallback: boolean = STATUS_BAR_DEFAULT): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** Das, was der Baustein vom Plugin braucht (`Plugin` erfüllt es). */
export interface StatusBarHost {
  addStatusBarItem(): HTMLElement;
}

export interface StatusBarItemOptions {
  plugin: StatusBarHost;
  /** Zustand des Schalters beim Start; Standard `STATUS_BAR_DEFAULT` (an). */
  visible?: boolean;
  /** Anfangstext; `null` blendet den Eintrag aus, ohne ihn abzuhängen (leerer Text, Klasse `is-hidden`). Ohne Angabe bleibt das Element, wie das Plugin es baut. */
  text?: string | null;
  /** Klassen, die jedes neu angelegte Element bekommt. */
  cls?: string | string[];
  /** Läuft bei jedem neu angelegten Element, vor dem ersten Zeichnen: Klick- und Tastatur-Zuhörer, `aria-*`, Kinder. */
  onCreate?: (el: HTMLElement) => void;
  /** Zeichnet den Inhalt (nach dem Anlegen, nach `refresh()` und nach `set(...)`); leeren und neu bauen ist Sache des Plugins. */
  render?: (el: HTMLElement) => void;
}

export interface StatusBarItemHandle {
  /** Der Text des Eintrags; `null` blendet ihn aus (leer, `is-hidden`), der Eintrag bleibt in der Leiste angelegt. Ist der Schalter aus, merkt sich der Handle den Text. */
  set(text: string | null): void;
  /** Der Schalter: `true` legt den Eintrag an, wenn er fehlt (nie einen zweiten), `false` hängt ihn ab. */
  setVisible(on: boolean): void;
  /** Blendet den Eintrag ein, auch bei ausgeschaltetem Schalter. Die Rückgabe nimmt das wieder zurück (einmal wirksam, jedes weitere Aufrufen tut nichts). */
  reveal(): () => void;
  /** Zeichnet den Eintrag neu (`render`, sonst der gemerkte Text). Tut nichts, solange der Eintrag fehlt. */
  refresh(): void;
  /** Steht der Eintrag gerade in der Leiste? */
  readonly shown: boolean;
  /** Das Element, solange der Eintrag in der Leiste steht, sonst `null`. */
  readonly el: HTMLElement | null;
  /** Hängt den Eintrag ab und beendet den Handle; alle späteren Aufrufe tun nichts. */
  destroy(): void;
}

export function createStatusBarItem(opts: StatusBarItemOptions): StatusBarItemHandle {
  let el: HTMLElement | null = null;
  let switchOn = opts.visible ?? STATUS_BAR_DEFAULT;
  let reveals = 0;
  let text: string | null | undefined = opts.text;
  let destroyed = false;

  const paint = (): void => {
    if (!el) return;
    if (text !== undefined) {
      el.setText(text ?? "");
      el.toggleClass("is-hidden", text === null);
      if (text === null) el.hide(); else el.show();
    }
    opts.render?.(el);
  };

  const sync = (): void => {
    if (destroyed) return;
    const want = switchOn || reveals > 0;
    if (want && !el) {
      el = opts.plugin.addStatusBarItem();
      const cls = opts.cls === undefined ? [] : Array.isArray(opts.cls) ? opts.cls : [opts.cls];
      if (cls.length > 0) el.addClass(...cls);
      opts.onCreate?.(el);
      paint();
    } else if (!want && el) {
      el.remove();
      el = null;
    }
  };

  sync();

  return {
    set(next) { if (destroyed) return; text = next; paint(); },
    setVisible(on) { switchOn = on; sync(); },
    reveal() {
      if (destroyed) return () => {};
      reveals++;
      sync();
      let open = true;
      return () => { if (!open) return; open = false; reveals--; sync(); };
    },
    refresh() { if (!destroyed) paint(); },
    get shown() { return el !== null; },
    get el() { return el; },
    destroy() {
      if (destroyed) return;
      el?.remove();
      el = null;
      destroyed = true;
    },
  };
}

// ── Einstellungszeile ──────────────────────────────────────────────────────────────────────────────

export interface StatusBarSettingStrings {
  name: string;
  /** Hilfetext der Zeile: sagt, was der Schalter tut und wann man ihn ausschaltet. */
  desc: string;
}

export interface StatusBarSettingStringsOverride extends Partial<StatusBarSettingStrings> {
  lang?: "en" | "de";
}

export interface StatusBarSettingOptions {
  /** Aktueller Zustand des Schalters; im Plugin `statusBarEnabled(settings.showStatusBar)`. */
  value: boolean;
  /** Der Schalter wurde umgelegt. Der Aufrufer ruft `item.setVisible(value)` und speichert. */
  onChange: (value: boolean) => void | Promise<void>;
  strings?: StatusBarSettingStringsOverride;
}

export const STATUS_BAR_SETTING_STRINGS_EN: StatusBarSettingStrings = {
  name: "Status bar",
  desc: "Show this plugin's entry in the status bar. Turn it off if the bar gets too wide.",
};

export const STATUS_BAR_SETTING_STRINGS_DE: StatusBarSettingStrings = {
  name: "Statusleiste",
  desc: "Zeigt den Eintrag dieses Plugins in der Statusleiste. Ausschalten, wenn die Leiste zu breit wird.",
};

/** Default der Sprache (EN ohne Angabe), Feld für Feld von `override` überlagert; ein ausdrückliches `undefined` überschreibt nichts. */
export function resolveStatusBarSettingStrings(override?: StatusBarSettingStringsOverride): StatusBarSettingStrings {
  const base = override?.lang === "de" ? STATUS_BAR_SETTING_STRINGS_DE : STATUS_BAR_SETTING_STRINGS_EN;
  if (!override) return base;
  const { lang: _lang, ...fields } = override;
  return { ...base, ...(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<StatusBarSettingStrings>) };
}

function applyToggle(setting: Setting, s: StatusBarSettingStrings, opts: StatusBarSettingOptions): Setting {
  return setting.setName(s.name).setDesc(s.desc).addToggle((t) => t.setValue(opts.value).onChange((v) => { void opts.onChange(v); }));
}

/** Für Tabs mit `display()`: die Zeile mit dem Schalter. */
export function buildStatusBarSetting(containerEl: HTMLElement, opts: StatusBarSettingOptions): Setting {
  return applyToggle(new Setting(containerEl), resolveStatusBarSettingStrings(opts.strings), opts);
}

/** Dieselbe Zeile als deklarative Definition (Render-Hatch) für Tabs mit `getSettingDefinitions()`; Name und Beschreibung stehen auch an der Definition (Suche). */
export function statusBarSettingDefinition(opts: StatusBarSettingOptions): SettingDefinitionRender {
  const s = resolveStatusBarSettingStrings(opts.strings);
  return { name: s.name, desc: s.desc, render: (setting) => { applyToggle(setting, s, opts); } };
}
