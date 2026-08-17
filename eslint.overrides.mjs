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
  // Frueher stand hier eine zweite Gruppe fuer src/obsidian/settings.ts: zwei
  // STORE-SCHULD-Overrides (settings-tab/prefer-setting-definitions und
  // @typescript-eslint/no-deprecated), gestundet mit der Begruendung, die Regel setze
  // Obsidian >=1.13 voraus, waehrend minAppVersion auf 1.8.7 steht.
  //
  // **Abgeloest am 2026-08-17** — und die Begruendung war ueberdies zu eng: der
  // zweigleisige Weg (getSettingDefinitions() als Wahrheit, Kit-Walker als Fallback fuer
  // <1.13) bedient beide Versionen gleichzeitig, minAppVersion musste dafuer nicht
  // steigen. `no-deprecated` faellt mit weg, weil der interne display()-Aufruf einer
  // eigenen renderImperative()-Methode gewichen ist.
  //
  // Die Messung von 2026-08-13 zum Vergleich: ohne die Overrides meldete `eslint src`
  // 4 Warnungen, alle in dieser Datei (prefer-setting-definitions @85, no-deprecated
  // @148/@201/@257). Heute meldet derselbe Lauf **null** — das ist der Beleg der
  // Abloesung, nicht die Behauptung.
];
