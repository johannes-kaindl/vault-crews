import { Notice, PluginSettingTab, Setting, type Plugin } from "obsidian";
import { t } from "../vendor/kit/i18n";
import { ENDPOINT_PRESETS, type EndpointStatus } from "../vendor/kit/endpoint_diagnostics";
import { parseEndpointList } from "../vendor/kit/endpoint";
import type { EndpointConfig } from "../vendor/kit/endpoint_config";
import { createModelListCache, type ModelListCache } from "../vendor/kit/model-list-cache";
import { guessFromName, type Capabilities } from "../vendor/kit/capabilities";
import { buildEndpointList, type EndpointListStrings } from "../vendor/kit-obsidian/endpoint-list";
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

function parseIntSafe(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
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

/**
 * Vier Gruppen (Spec §6.4): Connection · Crews · Safety · Advanced. Deklarative
 * Settings-API (`new Setting(containerEl)...`). Der Endpunkt-Zeilen-Editor kommt seit
 * 2026-08-14 vollständig aus dem Kit (`buildEndpointList`) — er trägt URL, Schlüssel und
 * Modell je Zeile. `display()` statt `getSettingDefinitions()`, weil `manifest.json`
 * minAppVersion < 1.13.0 ist (obsidianmd/require-display).
 */
export class SettingsTab extends PluginSettingTab {
  /** Modell-Listen je Endpunkt. Gehört der Lebensdauer DIESES Tabs, nicht der eines
   *  Renderdurchlaufs — sonst würde jeder Rebuild neu über das Netz gehen. */
  private readonly modelCache: ModelListCache = createModelListCache();
  /** Normalisierte URL des zuletzt aufgelösten aktiven Endpunkts (für die Rollenzeile). */
  private activeUrl: string | null = null;

  constructor(
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    // Echtes Plugin-Objekt statt Cast — main.ts ruft `new SettingsTab(this, this)`.
    // Alle Settings-Zugriffe laufen ausschließlich über `host`, nie über `this.plugin`.
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnection(containerEl);
    this.renderCrews(containerEl);
    this.renderSafety(containerEl);
    this.renderAdvanced(containerEl);

    // Die aktive Zeile steht erst fest, wenn die Proben zurück sind. Einmal je Aufbau
    // auflösen und dann NUR die Rollen neu zeichnen — nicht den ganzen Tab, sonst
    // verliert ein gerade getipptes Feld den Fokus.
    void this.host.resolveActive().then((url) => {
      if (url === this.activeUrl) return;
      this.activeUrl = url;
      this.display();
    });
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

  private renderConnection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.connection.heading")).setHeading();

    buildEndpointList({
      containerEl,
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
      rerender: () => this.display(),
      presets: ENDPOINT_PRESETS,
    });

    this.renderCapabilities(containerEl);
    this.renderDenied(containerEl);
  }

  /** Was das Modell kann, mit dem der nächste Lauf tatsächlich rechnet — also das der
   *  aktiven Zeile. Ohne erreichbaren Endpunkt gibt es nichts zu sagen, dann bleibt die
   *  Zeile weg statt zu raten. */
  private renderCapabilities(containerEl: HTMLElement): void {
    const active = this.host.settings.endpoints.find((cfg) => cfg.url === this.activeUrl)
      ?? this.host.settings.endpoints.find((cfg) => cfg.url.replace(/\/+$/, "").replace(/\/v1$/, "") === this.activeUrl);
    const model = active?.model?.trim() ?? "";
    if (model === "") return;
    new Setting(containerEl)
      .setName(model)
      .setDesc(capabilityLines(guessFromName(model)).join(" · "));
  }

  /** Sperrliste als schlichte Textarea: eine Sperre ist keine Verbindung — sie braucht
   *  weder Status-Icon noch Modellwahl noch einen Schlüssel. */
  private renderDenied(containerEl: HTMLElement): void {
    new Setting(containerEl)
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

  private renderCrews(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.crews.heading")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.crews.crewRoot.name"))
      .setDesc(t("settings.crews.crewRoot.desc"))
      .addText((c) =>
        c.setValue(this.host.settings.crewRoot).onChange(async (v) => {
          this.host.settings.crewRoot = v;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
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

  private renderSafety(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.safety.heading")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.safety.maxWrites.name"))
      .setDesc(t("settings.safety.maxWrites.desc"))
      .addText((c) =>
        c.setValue(String(this.host.settings.maxWrites)).onChange(async (v) => {
          this.host.settings.maxWrites = parseIntSafe(v, this.host.settings.maxWrites);
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.safety.wallClockMinutes.name"))
      .setDesc(t("settings.safety.wallClockMinutes.desc"))
      .addText((c) =>
        c.setValue(String(this.host.settings.wallClockMinutes)).onChange(async (v) => {
          this.host.settings.wallClockMinutes = parseIntSafe(v, this.host.settings.wallClockMinutes);
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.safety.undoHistoryDepth.name"))
      .setDesc(t("settings.safety.undoHistoryDepth.desc"))
      .addText((c) =>
        c.setValue(String(this.host.settings.undoHistoryDepth)).onChange(async (v) => {
          // Mindestens 1 aufheben (0 würde jeden Snapshot sofort wegprunen).
          this.host.settings.undoHistoryDepth = Math.max(1, parseIntSafe(v, this.host.settings.undoHistoryDepth));
          await this.host.saveSettings();
        }),
      );
  }

  private renderAdvanced(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.advanced.heading")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.advanced.callTimeoutS.name"))
      .setDesc(t("settings.advanced.callTimeoutS.desc"))
      .addText((c) =>
        c.setValue(String(this.host.settings.callTimeoutS)).onChange(async (v) => {
          this.host.settings.callTimeoutS = parseIntSafe(v, this.host.settings.callTimeoutS);
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.advanced.stallTimeoutS.name"))
      .setDesc(t("settings.advanced.stallTimeoutS.desc"))
      .addText((c) =>
        c.setValue(String(this.host.settings.stallTimeoutS)).onChange(async (v) => {
          this.host.settings.stallTimeoutS = parseIntSafe(v, this.host.settings.stallTimeoutS);
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.advanced.verboseLogging.name"))
      .setDesc(t("settings.advanced.verboseLogging.desc"))
      .addToggle((c) =>
        c.setValue(this.host.settings.verboseLogging).onChange(async (v) => {
          this.host.settings.verboseLogging = v;
          await this.host.saveSettings();
        }),
      );
  }
}
