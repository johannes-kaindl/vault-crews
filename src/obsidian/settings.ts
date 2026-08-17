import { Notice, PluginSettingTab, Setting, type Plugin, type SettingDefinitionItem } from "obsidian";
import { t } from "../vendor/kit/i18n";
import { ENDPOINT_PRESETS, type EndpointStatus } from "../vendor/kit/endpoint_diagnostics";
import { parseEndpointList } from "../vendor/kit/endpoint";
import type { EndpointConfig } from "../vendor/kit/endpoint_config";
import { createModelListCache, type ModelListCache } from "../vendor/kit/model-list-cache";
import { guessFromName, type Capabilities } from "../vendor/kit/capabilities";
import { buildEndpointList, type EndpointListStrings } from "../vendor/kit-obsidian/endpoint-list";
import { renderSettingDefinitions, settingBodyHost, refreshSettingsTab } from "../vendor/kit-obsidian/settings_walker";
import { statusKindKey, warnRuleKey } from "./endpoint-labels";

/**
 * User-facing Plugin-Settings (Sekunden/Minuten, nicht ms). Die Umrechnung in
 * RunLimits (ms-Felder) passiert erst beim Wiring in main.ts — hier bleibt es bei den
 * Rohwerten, die die Settings-UI zeigt/editiert.
 */
export interface PluginSettings {
  /** Geordnete Fallback-Liste. Jeder Eintrag trägt URL, API-Schlüssel und Modell
   *  zusammen — ein Modellname existiert nur auf dem Endpunkt, der ihn meldet, deshalb
   *  gibt es KEIN globales Modellfeld (Design 2026-08-14, E1). */
  endpoints: EndpointConfig[];
  /** Sperrliste. Bewusst weiterhin rohe URLs: eine Sperre ist keine Verbindung — dort
   *  hat weder ein Schlüssel noch ein Modell etwas zu suchen. */
  deniedEndpoints: string[];
  crewRoot: string;
  maxWrites: number;
  wallClockMinutes: number;
  callTimeoutS: number;
  stallTimeoutS: number;
  undoHistoryDepth: number;
  verboseLogging: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  endpoints: [{ url: "http://localhost:1234/v1" }],
  deniedEndpoints: ["http://localhost:8080", "http://127.0.0.1:8080"],
  crewRoot: "_crews",
  maxWrites: 10,
  wallClockMinutes: 10,
  callTimeoutS: 300,
  stallTimeoutS: 60,
  undoHistoryDepth: 15,
  verboseLogging: false,
};

/**
 * Schmaler Vertrag statt eines main.ts-Imports (Entkopplung PROF-OBS: SettingsTab
 * kennt nie die konkrete Plugin-Klasse).
 */
export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  /** Probt GENAU EINEN Eintrag — mitsamt seinem Schlüssel, sonst gilt ein Gateway, das
   *  unauthentifiziert 401 antwortet, fälschlich als tot. */
  probeEndpoint(cfg: EndpointConfig): Promise<EndpointStatus>;
  /** Modelle GENAU DIESES Eintrags (Dropdown je Zeile). */
  listModels(cfg: EndpointConfig): Promise<string[]>;
  /** Normalisierte URL des ersten erreichbaren Eintrags, oder null. */
  resolveActive(): Promise<string | null>;
}

/** Der Textbaustein-Satz, den der Kit-Editor bekommt — das Kit formuliert nicht. */
function endpointStrings(): EndpointListStrings {
  return {
    addPlaceholder: t("settings.connection.endpoints.add"),
    apiKeyPlaceholder: t("settings.connection.apiKey.placeholder"),
    modelPlaceholder: t("settings.connection.model.placeholder"),
    ariaUrl: t("settings.connection.aria.url"),
    ariaAdd: t("settings.connection.aria.add"),
    ariaApiKey: (url) => t("settings.connection.aria.apiKey", url),
    ariaModel: (url) => t("settings.connection.aria.model", url),
    // Kein globales Modell in diesem Plugin: die Leer-Option heißt hier schlicht
    // „nichts gewählt". Der Parameter bleibt Teil des Kit-Vertrags (s. Kit-Todo
    // „globales Modellfeld terminieren") und wird bewusst ignoriert.
    emptyModelLabel: () => t("settings.connection.model.unset"),
    modelHint: (key) =>
      key === "unreachable"
        ? t("settings.connection.model.hint.unreachable")
        : key === "no-list"
          ? t("settings.connection.model.hint.noList")
          : "",
    savedSuffix: t("settings.connection.model.saved"),
    refreshModels: t("settings.connection.model.refresh"),
    moveToFront: t("settings.connection.moveToFront"),
    remove: t("settings.connection.remove"),
    thirdParty: t("settings.connection.thirdParty"),
    probing: t("settings.connection.probing"),
    statusTooltip: (status) => t(statusKindKey(status.kind)),
    role: (role) =>
      role.kind === "active"
        ? t("settings.connection.role.active")
        : role.kind === "unreachable"
          ? t("settings.connection.role.unreachable")
          : role.kind === "skipped-model"
            ? t("settings.connection.role.modelMismatch")
            : t("settings.connection.role.standby", String(role.position)),
    warnings: (ws) => ws.map((w) => t(warnRuleKey(w.rule))).join(" · "),
    presetTooltip: (preset) => t("settings.connection.presetAdd", preset.url),
    presetLabel: (preset) => t("settings.connection.presetAdd", preset.label),
    checkConnection: t("settings.connection.probe"),
    saveFailed: t("settings.connection.saveFailed"),
  };
}

/** Was von einem Modellnamen über seine Fähigkeiten ableitbar ist — und wie sicher.
 *  Bewusst als Vermutung beschriftet, wenn es eine ist: die Namens-Heuristik behauptet
 *  nie mehr, als der Name hergibt. */
function capabilityLines(caps: Capabilities): string[] {
  const out: string[] = [];
  if (caps.thinking.confidence === "confirmed") out.push(t("settings.connection.capabilities.thinking.confirmed"));
  else if (caps.thinking.support !== "none") out.push(t("settings.connection.capabilities.thinking.likely"));
  else out.push(t("settings.connection.capabilities.thinking.no"));
  if (caps.vision === "confirmed") out.push(t("settings.connection.capabilities.vision.confirmed"));
  else if (caps.vision === "likely") out.push(t("settings.connection.capabilities.vision.likely"));
  return out;
}

/** Eine Zeile der deklarativen Struktur: entweder ein generischer Regler (`control`) oder
 *  ein eigener Renderer (`render`). Beides zusammen gibt es nicht — und keins von beidem
 *  auch nicht: eine Zeile ohne Regler überspringt der native ≥1.13-Renderer stillschweigend,
 *  während der Fallback-Walker sie zeichnet (Fund yijing-oracle, REGISTRY). Der Wächter dazu
 *  steht in `tests/obsidian/settings-definitions.test.ts`. */
type ControlDef = { type: "text" | "number" | "toggle"; key: keyof PluginSettings; placeholder?: string };
type ItemDef = { name?: string; desc?: string; control?: ControlDef; render?: (setting: Setting) => void };
type GroupDef = { type: "group"; heading: string; items: ItemDef[] };

/**
 * Vier Gruppen (Spec §6.4): Connection · Crews · Safety · Advanced.
 *
 * **Zweigleisig, eine Wahrheit.** `getSettingDefinitions()` IST die Struktur; ab Obsidian
 * 1.13 fragt der Host sie selbst ab und ruft `display()` nie. Darunter zeichnet der
 * Kit-Walker (`renderSettingDefinitions`) dieselbe Struktur mit der klassischen
 * `Setting`-API nach. Beides ist nötig, weil `manifest.json` auf minAppVersion 1.8.7 steht.
 * Ohne die Methode erscheint **keine** Einstellung dieses Plugins in Obsidians
 * Einstellungs-Suche — gemessen an yijing-oracle (0 → 7 registrierte Zeilen), und der
 * Store-Scan mahnt sie als `prefer-setting-definitions` an.
 *
 * Was nicht deklarativ geht, läuft über `render`-Hatches: der Kit-Endpunkt-Editor bringt
 * sein eigenes DOM mit, die Sperrliste committet erst beim Verlassen des Feldes, und der
 * Beispiel-Knopf ist ein Knopf. `settingBodyHost` macht die Zeile dafür zum leeren Block.
 */
export class SettingsTab extends PluginSettingTab {
  /** Modell-Listen je Endpunkt. Gehört der Lebensdauer DIESES Tabs, nicht der eines
   *  Renderdurchlaufs — sonst würde jeder Rebuild neu über das Netz gehen. */
  private readonly modelCache: ModelListCache = createModelListCache();
  /** Normalisierte URL des zuletzt aufgelösten aktiven Endpunkts (für die Rollenzeile). */
  private activeUrl: string | null = null;
  /** Verhindert, dass jeder Rebuild eine weitere Auflösung nachschiebt. */
  private resolving = false;
  /** Cleanups der Hatches des vorigen Fallback-Durchlaufs. */
  private cleanupPrevious: () => void = () => {};

  constructor(
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    // Echtes Plugin-Objekt statt Cast — main.ts ruft `new SettingsTab(this, this)`.
    // Alle Settings-Zugriffe laufen ausschließlich über `host`, nie über `this.plugin`.
    super(plugin.app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    // Beide Pfade kommen hier vorbei — der native ≥1.13 direkt, der Fallback über
    // renderImperative(). Deshalb hängt die Auflösung des aktiven Endpunkts hier und
    // nicht mehr in display(): unter 1.13 wird display() nie gerufen, und die Rollen-
    // und Fähigkeiten-Anzeige bliebe für immer leer.
    this.ensureActiveResolved();

    const defs: GroupDef[] = [
      {
        type: "group",
        heading: t("settings.connection.heading"),
        items: [
          {
            name: t("settings.connection.endpoints.name"),
            desc: t("settings.connection.endpoints.desc"),
            render: (setting) => this.renderEndpoints(setting),
          },
          // Bedingte Zeile: WEGGELASSEN statt per `visible` versteckt. Der native
          // 1.13-Renderer wertet `visible: false` nicht aus, die Zeile bliebe stehen
          // (Fund obsidian-paperize, REGISTRY). Weglassen wirkt in beiden Pfaden, weil
          // diese Methode bei jedem Rebuild neu ausgewertet wird.
          ...this.capabilityItems(),
          {
            name: t("settings.connection.deniedEndpoints.name"),
            desc: t("settings.connection.deniedEndpoints.desc"),
            render: (setting) => this.renderDenied(setting),
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.crews.heading"),
        items: [
          {
            name: t("settings.crews.crewRoot.name"),
            desc: t("settings.crews.crewRoot.desc"),
            control: { type: "text", key: "crewRoot" },
          },
          {
            name: t("settings.crews.installExamples.name"),
            desc: t("settings.crews.installExamples.desc"),
            render: (setting) => this.renderInstallExamples(setting),
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.safety.heading"),
        items: [
          {
            name: t("settings.safety.maxWrites.name"),
            desc: t("settings.safety.maxWrites.desc"),
            control: { type: "number", key: "maxWrites" },
          },
          {
            name: t("settings.safety.wallClockMinutes.name"),
            desc: t("settings.safety.wallClockMinutes.desc"),
            control: { type: "number", key: "wallClockMinutes" },
          },
          {
            name: t("settings.safety.undoHistoryDepth.name"),
            desc: t("settings.safety.undoHistoryDepth.desc"),
            control: { type: "number", key: "undoHistoryDepth" },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.advanced.heading"),
        items: [
          {
            name: t("settings.advanced.callTimeoutS.name"),
            desc: t("settings.advanced.callTimeoutS.desc"),
            control: { type: "number", key: "callTimeoutS" },
          },
          {
            name: t("settings.advanced.stallTimeoutS.name"),
            desc: t("settings.advanced.stallTimeoutS.desc"),
            control: { type: "number", key: "stallTimeoutS" },
          },
          {
            name: t("settings.advanced.verboseLogging.name"),
            desc: t("settings.advanced.verboseLogging.desc"),
            control: { type: "toggle", key: "verboseLogging" },
          },
        ],
      },
    ];
    return defs as unknown as SettingDefinitionItem[];
  }

  /** Ab 1.13 rendert der Host aus den Definitionen und ruft das hier nie. */
  display(): void {
    this.renderImperative();
  }

  /** Beim Schließen des Tabs die gecachten Modell-Listen verwerfen — Pflicht des
   *  Consumers, das Kit-Modul kennt keinen Tab. Ohne das bliebe ein einmal als „nicht
   *  erreichbar" gemessener Endpunkt für die restliche Sitzung so stehen: wer seinen
   *  LLM-Server erst danach startet und die Einstellungen erneut öffnet, sähe dauerhaft
   *  den alten Zustand. */
  hide(): void {
    this.modelCache.clear();
    this.activeUrl = null;
    super.hide();
  }

  getControlValue(key: string): string | number | boolean | undefined {
    const s = this.host.settings;
    switch (key) {
      case "crewRoot":
        return s.crewRoot;
      case "maxWrites":
        return s.maxWrites;
      case "wallClockMinutes":
        return s.wallClockMinutes;
      case "undoHistoryDepth":
        return s.undoHistoryDepth;
      case "callTimeoutS":
        return s.callTimeoutS;
      case "stallTimeoutS":
        return s.stallTimeoutS;
      case "verboseLogging":
        return s.verboseLogging;
      default:
        return undefined;
    }
  }

  setControlValue(key: string, value: unknown): void {
    const s = this.host.settings;
    // Der Walker reicht bei `number` ein rohes `Number(v)` durch — bei leerem oder
    // unfertigem Feld ist das `NaN`. Auf den bisherigen Wert zurückfallen, sonst
    // überschreibt jeder Zwischenzustand beim Tippen die Einstellung.
    const asInt = (fallback: number): number => {
      const parsed = Number.parseInt(String(value), 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    switch (key) {
      case "crewRoot":
        s.crewRoot = String(value);
        break;
      case "maxWrites":
        s.maxWrites = asInt(s.maxWrites);
        break;
      case "wallClockMinutes":
        s.wallClockMinutes = asInt(s.wallClockMinutes);
        break;
      case "undoHistoryDepth":
        // Mindestens 1 aufheben (0 würde jeden Snapshot sofort wegprunen).
        s.undoHistoryDepth = Math.max(1, asInt(s.undoHistoryDepth));
        break;
      case "callTimeoutS":
        s.callTimeoutS = asInt(s.callTimeoutS);
        break;
      case "stallTimeoutS":
        s.stallTimeoutS = asInt(s.stallTimeoutS);
        break;
      case "verboseLogging":
        s.verboseLogging = Boolean(value);
        break;
      default:
        return;
    }
    void this.host.saveSettings();
  }

  /** Den vollen Fallback-Baum neu zeichnen. Bewusst NICHT `display()` aufrufen: ein
   *  interner Aufruf löst ab 1.13 die Deprecation-Warnung aus (Fund obsidian-paperize). */
  private renderImperative(): void {
    this.cleanupPrevious();
    const { containerEl } = this;
    containerEl.empty();
    this.cleanupPrevious = renderSettingDefinitions(
      containerEl,
      this.getSettingDefinitions(),
      this,
      this.app,
    );
  }

  /** Nach einer Zustandsänderung die Oberfläche nachziehen — ab 1.13 über die native
   *  `update()`-API, darunter über den vollen Rebuild. */
  private refreshUi(): void {
    refreshSettingsTab(this, () => this.renderImperative());
  }

  /** Die aktive Zeile steht erst fest, wenn die Proben zurück sind. Einmal je Zustand
   *  auflösen und dann nachziehen — nicht bei jedem Rebuild erneut, sonst dreht sich
   *  Auflösung und Neuzeichnen im Kreis. */
  private ensureActiveResolved(): void {
    if (this.resolving) return;
    this.resolving = true;
    void this.host.resolveActive().then((url) => {
      this.resolving = false;
      if (url === this.activeUrl) return;
      this.activeUrl = url;
      this.refreshUi();
    });
  }

  private renderEndpoints(setting: Setting): void {
    buildEndpointList({
      containerEl: settingBodyHost(setting),
      label: t("settings.connection.endpoints.name"),
      desc: t("settings.connection.endpoints.desc"),
      placeholder: t("settings.connection.endpoints.add"),
      strings: endpointStrings(),
      cache: this.modelCache,
      get: () => this.host.settings.endpoints,
      set: (eps) => {
        this.host.settings.endpoints = eps;
      },
      active: () => this.activeUrl,
      // EIN Client je Zeile für Status-Icon UND Modell-Liste: liefen sie über zwei
      // getrennte Konstruktionen, könnten sie für dieselbe Zeile auseinanderlaufen.
      // Die Rückgabetypen stehen ausgeschrieben, weil `clientFor` eine Intersection
      // zweier `probe()`-Signaturen ist — ein Objekt-Literal ohne Annotation lässt TS
      // die Union inferieren, die dann keine der beiden Seiten erfüllt (Fund vim-dojo).
      clientFor: (cfg: EndpointConfig) => ({
        probe: (): Promise<EndpointStatus> => this.host.probeEndpoint(cfg),
        listModels: (): Promise<string[]> => this.host.listModels(cfg),
      }),
      // Dieses Plugin hat KEIN globales Modell — das Modell gehört zum Endpunkt, der es
      // meldet. Der Callback ist im Kit-Vertrag Pflicht; er zu erfüllen heißt hier, den
      // leeren String zu liefern. Genau diese Reibung ist der Beleg für den Kit-Todo
      // „globales Modellfeld terminieren" (obsidian-kit-Cockpit, 2026-08-14).
      globalModel: () => "",
      save: () => this.host.saveSettings(),
      reconnect: async () => {
        this.activeUrl = await this.host.resolveActive();
      },
      rerender: () => this.refreshUi(),
      presets: ENDPOINT_PRESETS,
    });
  }

  /** Was das Modell kann, mit dem der nächste Lauf tatsächlich rechnet — also das der
   *  aktiven Zeile. Ohne erreichbaren Endpunkt gibt es nichts zu sagen, dann entfällt die
   *  Zeile ganz, statt zu raten. */
  private capabilityItems(): ItemDef[] {
    const active = this.host.settings.endpoints.find((cfg) => cfg.url === this.activeUrl)
      ?? this.host.settings.endpoints.find((cfg) => cfg.url.replace(/\/+$/, "").replace(/\/v1$/, "") === this.activeUrl);
    const model = active?.model?.trim() ?? "";
    if (model === "") return [];
    const desc = capabilityLines(guessFromName(model)).join(" · ");
    // Als Hatch, nicht als reine name/desc-Zeile: eine Zeile ohne Regler überspringt der
    // native ≥1.13-Renderer stillschweigend (Fund yijing-oracle, REGISTRY).
    return [{ name: model, desc, render: (setting) => { setting.setName(model).setDesc(desc); } }];
  }

  /** Sperrliste als schlichte Textarea: eine Sperre ist keine Verbindung — sie braucht
   *  weder Status-Icon noch Modellwahl noch einen Schlüssel. */
  private renderDenied(setting: Setting): void {
    setting
      .setName(t("settings.connection.deniedEndpoints.name"))
      .setDesc(t("settings.connection.deniedEndpoints.desc"))
      .addTextArea((c) => {
        c.setValue(this.host.settings.deniedEndpoints.join("\n"));
        // Commit bei blur, nicht bei jedem Tastendruck — sonst zerlegt jede Zwischenform
        // die Liste.
        c.inputEl.addEventListener("blur", () => {
          const next = parseEndpointList(c.getValue());
          const cur = this.host.settings.deniedEndpoints;
          if (next.length === cur.length && next.every((e, i) => e === cur[i])) return;
          this.host.settings.deniedEndpoints = next;
          void this.host.saveSettings();
        });
      });
  }

  private renderInstallExamples(setting: Setting): void {
    setting
      .setName(t("settings.crews.installExamples.name"))
      .setDesc(t("settings.crews.installExamples.desc"))
      .addButton((btn) =>
        btn.setButtonText(t("settings.crews.installExamples.button")).onClick(() => {
          // Installation läuft über den Command „Install example crews" (main.ts, Task
          // 16b, ruft install-examples.ts aus Task 18 auf) — SettingsHost hält bewusst
          // keinen eigenen Install-Pfad (schmaler, stabiler Vertrag für diese Klasse).
          new Notice(t("notice.install.useCommand"));
        }),
      );
  }
}
