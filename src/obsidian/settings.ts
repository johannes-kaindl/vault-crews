import { Notice, Plugin, PluginSettingTab, Setting, setIcon } from "obsidian";
import { t } from "../vendor/kit/i18n";
import {
  ENDPOINT_PRESETS,
  validateEndpointInput,
  type EndpointStatus,
  type EndpointStatusKind,
} from "../vendor/kit/endpoint_diagnostics";
import {
  activeIndexFromStatuses,
  applyEndpointEdit,
  modelFieldMode,
  statusKindKey,
  warnRuleKey,
} from "./endpoint-editor-model";

/**
 * User-facing Plugin-Settings (Sekunden/Minuten, nicht ms). Die Umrechnung in
 * RunLimits (ms-Felder, Interface-Skelett) passiert erst beim Wiring in main.ts
 * (Task 16b) — hier bleibt es bei den Rohwerten, die die Settings-UI zeigt/editiert.
 */
export interface PluginSettings {
  endpoints: string[];
  deniedEndpoints: string[];
  defaultModel: string;
  crewRoot: string;
  maxWrites: number;
  wallClockMinutes: number;
  callTimeoutS: number;
  stallTimeoutS: number;
  undoHistoryDepth: number;
  verboseLogging: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
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
};

/**
 * Schmaler Vertrag statt eines main.ts-Imports (Entkopplung PROF-OBS: SettingsTab
 * kennt nie die konkrete Plugin-Klasse). main.ts (Task 16b) übergibt sein
 * Plugin-Objekt, das diese Mitglieder implementiert.
 */
export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  /** Probt EINEN Endpoint und klassifiziert das Ergebnis (Per-Zeile-Status im Editor). */
  probeEndpoint(endpoint: string): Promise<EndpointStatus>;
  /** Löst den ersten erreichbaren Endpoint auf und listet seine Modelle (Modell-Dropdown). */
  loadModels(): Promise<{ endpoint: string | null; models: string[] }>;
}

function parseIntSafe(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

interface ListEditorOpts {
  list: string[];
  name: string;
  desc: string;
  /** Endpoints: Per-Zeile-Probe + aktiver Marker + Preset-Aktionszeile. Denied: alles aus. */
  withProbe: boolean;
  withPresets: boolean;
  setList(next: string[]): void;
}

/**
 * Vier Gruppen (Spec §6.4): Connection · Crews · Safety · Advanced. Deklarative
 * Settings-API (`new Setting(containerEl)...`). Der Endpoint-/Denied-Zeilen-Editor
 * (`buildListEditor`) übernimmt das obsidian-kit/vault-rag-Muster; die reine Logik lebt
 * obsidian-frei in `endpoint-editor-model.ts` (Ansatz A). `display()` statt
 * `getSettingDefinitions()`, weil `manifest.json` minAppVersion 1.7.2 < 1.13.0 ist
 * (obsidianmd/require-display).
 */
export class SettingsTab extends PluginSettingTab {
  /** Von der letzten `loadModels()`-Abfrage gecachte Modell-Liste; steuert den Modell-
   *  Feld-Modus (dropdown vs. freetext). Initial leer → Freitext, kein Auto-Netz-Hit. */
  private loadedModels: string[] = [];

  constructor(
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    // Echtes Plugin-Objekt statt Cast (main.ts, Task 16b, ruft `new SettingsTab(this,
    // this)` — seine Plugin-Klasse extends `Plugin` UND implementiert `SettingsHost`).
    // `PluginSettingTab` setzt daraus `this.app`; alle Settings-Zugriffe dieser Klasse
    // laufen weiterhin ausschließlich über `host` (`this.host`), nie über `this.plugin`.
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnection(containerEl);
    this.renderCrews(containerEl);
    this.renderSafety(containerEl);
    this.renderAdvanced(containerEl);
  }

  private renderConnection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.connection.heading")).setHeading();

    this.buildListEditor(containerEl, {
      list: this.host.settings.endpoints,
      name: t("settings.connection.endpoints.name"),
      desc: t("settings.connection.endpoints.desc"),
      withProbe: true,
      withPresets: true,
      setList: (next) => {
        this.host.settings.endpoints = next;
      },
    });

    this.renderModelField(containerEl);

    this.buildListEditor(containerEl, {
      list: this.host.settings.deniedEndpoints,
      name: t("settings.connection.deniedEndpoints.name"),
      desc: t("settings.connection.deniedEndpoints.desc"),
      withProbe: false,
      withPresets: false,
      setList: (next) => {
        this.host.settings.deniedEndpoints = next;
      },
    });
  }

  /** Ein parametrisierter Zeilen-Editor für Endpoints (mit Probe/Presets/Active) und
   *  Denied (nur Add/Remove + Eingabe-Warnungen). Letzte Leerzeile ist der Adder. */
  private buildListEditor(containerEl: HTMLElement, opts: ListEditorOpts): void {
    const statuses: (EndpointStatusKind | null)[] = opts.list.map(() => null);
    const statusEls: HTMLElement[] = [];
    const rows = [...opts.list, ""]; // letzte Leerzeile = Adder

    const commit = (next: string[]): void => {
      opts.setList(next);
      void this.host.saveSettings().then(() => this.display());
    };

    rows.forEach((value, i) => {
      const isAdder = i >= opts.list.length;
      const setting = new Setting(containerEl);
      if (i === 0) setting.setName(opts.name).setDesc(opts.desc);

      if (opts.withProbe && !isAdder) {
        const statusEl = setting.settingEl.createSpan({ cls: "vault-crews-ep-status" });
        setIcon(statusEl, "loader");
        statusEls.push(statusEl);
      }

      setting.addText((c) => {
        c.setValue(value);
        if (isAdder) c.setPlaceholder(t("settings.connection.endpoints.add"));
        // Mutation NUR bei blur (nicht onChange): onChange feuert pro Tastendruck und
        // würde im Adder jeden Zwischenstand (`h`, `ht`, …) anhängen.
        c.inputEl.addEventListener("blur", () => {
          const next = applyEndpointEdit(opts.list, i, c.getValue(), isAdder);
          if (next.length === opts.list.length && next.every((e, k) => e === opts.list[k])) return;
          commit(next);
        });
      });

      // Eingabe-Warnungen (beide Listen): nicht-blockierend, nur Hinweis.
      if (!isAdder) {
        const warnings = validateEndpointInput(value);
        if (warnings.length > 0) {
          const warnEl = setting.settingEl.createSpan({ cls: "vault-crews-ep-warn" });
          setIcon(warnEl, "alert-triangle");
          warnEl.setAttribute("aria-label", warnings.map((w) => t(warnRuleKey(w.rule))).join(" · "));
        }
        setting.addExtraButton((b) =>
          b
            .setIcon("trash-2")
            .setTooltip(t("settings.connection.remove"))
            .onClick(() => commit(applyEndpointEdit(opts.list, i, "", false))),
        );
      }
    });

    if (opts.withPresets) {
      const actions = new Setting(containerEl);
      for (const preset of ENDPOINT_PRESETS) {
        actions.addButton((b) =>
          b.setButtonText(t("settings.connection.presetAdd", preset.label)).onClick(() => {
            if (!opts.list.includes(preset.url)) commit([...opts.list, preset.url]);
          }),
        );
      }
      actions.addButton((b) =>
        b.setButtonText(t("settings.connection.probe")).onClick(() => this.display()),
      );
    }

    if (opts.withProbe) {
      opts.list.forEach((ep, i) => {
        void this.host.probeEndpoint(ep).then((status) => {
          statuses[i] = status.kind;
          const el = statusEls[i];
          if (el) {
            el.removeClass("is-ok", "is-error");
            setIcon(el, status.reachable ? "circle-check" : "circle-x");
            el.addClass(status.reachable ? "is-ok" : "is-error");
            el.setAttribute("aria-label", t(statusKindKey(status.kind)));
          }
          const active = activeIndexFromStatuses(statuses);
          statusEls.forEach((se, j) => se.toggleClass("is-active", j === active));
        });
      });
    }
  }

  /** Standardmodell: Dropdown aus den zuletzt geladenen Modellen, sonst Freitext-Fallback
   *  (offline oder gespeichertes Modell nicht in der Liste — nie ein toter Zustand). */
  private renderModelField(containerEl: HTMLElement): void {
    const saved = this.host.settings.defaultModel;
    const setting = new Setting(containerEl)
      .setName(t("settings.connection.defaultModel.name"))
      .setDesc(t("settings.connection.defaultModel.desc"));

    if (modelFieldMode(this.loadedModels, saved) === "dropdown") {
      setting.addDropdown((d) => {
        if (saved === "") d.addOption("", t("settings.connection.model.choose"));
        for (const m of this.loadedModels) d.addOption(m, m);
        d.setValue(saved).onChange(async (v) => {
          this.host.settings.defaultModel = v;
          await this.host.saveSettings();
        });
      });
    } else {
      setting.addText((c) =>
        c.setValue(saved).onChange(async (v) => {
          this.host.settings.defaultModel = v;
          await this.host.saveSettings();
        }),
      );
    }

    setting.addButton((b) =>
      b.setButtonText(t("settings.connection.model.load")).onClick(async () => {
        const { endpoint, models } = await this.host.loadModels();
        this.loadedModels = models;
        if (endpoint === null) new Notice(t("settings.connection.model.none"));
        this.display();
      }),
    );
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
