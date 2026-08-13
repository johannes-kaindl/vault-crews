// Repo-eigene ESLint-Abweichungen — der EINZIGE Ort dafuer. Der Kern
// (eslint.config.mjs) ist template-verwaltet, Inline-disables blockt das Lint-Gate.
// Jeder Override braucht eine Begruendung im Kommentar.
//
// Zwei Klassen, zwei Preise (Details: _docs/docs/obsidian-plugin-publishing.md):
// - Kosmetik-/Benennungsregeln (z. B. ui/sentence-case bei Eigennamen/API-Namen):
//   Override ist die richtige Antwort und kostet nichts — der Scanner hat keinen
//   Mangel gefunden, sondern eine Konvention falsch angelegt.
// - Faehigkeitsregeln (z. B. settings-tab/prefer-setting-definitions): der Scanner
//   bewertet den Mangel, nicht die Begruendung — ein Override hier ist gestundete
//   Schuld und kostet die Store-Wertung ("Satisfactory" statt "Passed").
//   Marker fuer solche Faelle: `// STORE-SCHULD:` + wo die Abloesung geplant ist.
export default [
  {
    // Type-aware Linting braucht das Build-tsconfig des Repos. Achtung Falle
    // (json_viewer 1.9.0): ein obsidian→Mock-paths-Alias im referenzierten tsconfig
    // laesst die type-aware Regeln auf einen losen Mock aufloesen → no-unsafe-*-Kaskade.
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/obsidian/settings.ts"],
    rules: {
      // STORE-SCHULD: Regel setzt Obsidian >=1.13.0 voraus (getSettingDefinitions()/
      // deklarative Settings-API); manifest.json's minAppVersion ist 1.8.7 < 1.13.0,
      // also ist display() hier der einzig unterstuetzte Weg. Der Scanner bewertet
      // trotzdem den Mangel, nicht die Begruendung — das ist gestundete Schuld, kein
      // Fehlalarm. Abloesung: Migration auf getSettingDefinitions(), sobald
      // minAppVersion auf >=1.13.0 zieht.
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
      // STORE-SCHULD: this.display() ruft die deprecated PluginSettingTab.display()
      // erneut auf (Re-Render-Pattern der Listen-Editoren), aus demselben
      // minAppVersion-Grund wie oben. Abloesung: gemeinsam mit der Migration auf
      // getSettingDefinitions() (siehe Override oben), nicht isoliert vorher.
      "@typescript-eslint/no-deprecated": "off",
      //
      // Was diese beiden Overrides den Store-Scanner NICHT sehen lassen, gemessen
      // 2026-08-13 (eslint src ohne Overrides): 4 Warnungen, alle in dieser Datei —
      // prefer-setting-definitions @85 und no-deprecated @148/@201/@257. Die Zahl
      // gehoert hierher, weil es seither kein zweites Lint-Skript mehr gibt, das sie
      // von sich aus zeigt; die Gegenprobe ist `eslint src` mit einer Kopie des
      // Kerns ohne diese Datei.
    },
  },
];
