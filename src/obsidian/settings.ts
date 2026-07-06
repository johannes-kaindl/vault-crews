import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { t } from "../vendor/kit/i18n";

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
 * Plugin-Objekt, das diese drei Mitglieder implementiert.
 */
export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  testConnection(endpoint: string): Promise<{ ok: boolean; models: string[] }>;
}

function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseIntSafe(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Vier Gruppen (Spec §6.4): Connection · Crews · Safety · Advanced. Deklarative
 * Settings-API (`new Setting(containerEl)...`), keine Toggles für „ohne Git
 * erlauben"/„immer committen" (bewusst entfernt, siehe Spec). `display()` statt
 * `getSettingDefinitions()`, weil `manifest.json` minAppVersion 1.7.2 < 1.13.0 ist
 * (obsidianmd/require-display).
 */
export class SettingsTab extends PluginSettingTab {
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

    new Setting(containerEl)
      .setName(t("settings.connection.endpoints.name"))
      .setDesc(t("settings.connection.endpoints.desc"))
      .addTextArea((c) =>
        c.setValue(this.host.settings.endpoints.join("\n")).onChange(async (v) => {
          this.host.settings.endpoints = parseLines(v);
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.connection.deniedEndpoints.name"))
      .setDesc(t("settings.connection.deniedEndpoints.desc"))
      .addTextArea((c) =>
        c.setValue(this.host.settings.deniedEndpoints.join("\n")).onChange(async (v) => {
          this.host.settings.deniedEndpoints = parseLines(v);
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.connection.defaultModel.name"))
      .setDesc(t("settings.connection.defaultModel.desc"))
      .addText((c) =>
        c.setValue(this.host.settings.defaultModel).onChange(async (v) => {
          this.host.settings.defaultModel = v;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.connection.testConnection.name"))
      .setDesc(t("settings.connection.testConnection.desc"))
      .addButton((btn) =>
        btn.setButtonText(t("settings.connection.testConnection.button")).onClick(() => this.runConnectionTest()),
      );
  }

  /** Probiert die konfigurierten Endpoints der Reihe nach; genau eine Notice mit dem Ergebnis. */
  private async runConnectionTest(): Promise<void> {
    for (const endpoint of this.host.settings.endpoints) {
      const result = await this.host.testConnection(endpoint);
      if (result.ok) {
        new Notice(t("notice.testConnection.ok", result.models.length, result.models.join(", ")));
        return;
      }
    }
    new Notice(t("notice.testConnection.failed"));
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
