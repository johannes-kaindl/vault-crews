// Obsidian-Guideline-Gate (PROF-OBS-08): type-checked gegen ECHTE obsidian-Typen.
// KEIN Inline-`// eslint-disable` — genuin unvermeidbare Ausnahmen NUR als file-scoped
// Override unten, mit Begruendung (Review verbietet Inline-disables).
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/", "tests/__mocks__/"] },
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // --- file-scoped Overrides (Beispiel, auskommentiert) ---------------------
  // {
  //   files: ["src/streaming.ts"],
  //   rules: { "obsidianmd/no-restricted-globals": "off" }, // SSE via activeWindow.fetch, requestUrl kann nicht streamen
  // },
  {
    files: ["src/obsidian/settings.ts"],
    rules: {
      // Regel setzt Obsidian >=1.13.0 voraus (getSettingDefinitions()/deklarative
      // Settings-API); manifest.json's minAppVersion ist 1.7.2 < 1.13.0, also ist
      // display() hier der einzig unterstützte Weg — Warnung ist ein Fehlalarm.
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
    },
  },
  {
    files: ["src/main.ts"],
    rules: {
      // prefer-get-language empfiehlt getLanguage(); no-unsupported-api verbietet es
      // aber als Fehler, weil getLanguage() erst ab Obsidian 1.8.7 existiert und
      // manifest.json's minAppVersion 1.7.2 ist. Der einzige widerspruchsfreie Weg ist
      // der stabile localStorage-Key `language` (siehe readObsidianLocale) — die
      // Warnung ist hier ein Fehlalarm des Versionskonflikts.
      "obsidianmd/prefer-get-language": "off",
    },
  },
);
