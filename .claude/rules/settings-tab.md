---
paths:
  - "src/obsidian/settings.ts"
  - "tests/obsidian/settings-definitions.test.ts"
  - "tests/obsidian/settings.test.ts"
  - "scripts/gui-smoke.ts"
---

# Settings-Tab — zwei Gleise

Gotchas zum Einstellungs-Tab, der in Obsidian ab 1.13 nativ aus Definitionen gerendert wird und in älteren Versionen über den Kit-Walker.

- **Der Settings-Tab ist zweigleisig — und beide Gleise müssen bedient bleiben.** `getSettingDefinitions()` IST die Struktur (Obsidian ≥ 1.13 rendert daraus und ruft `display()` nie); der vendorte Kit-Walker zeichnet dieselbe Struktur mit der klassischen `Setting`-API nach, solange Obsidian älter ist. `minAppVersion` bleibt deshalb unter 1.13 (heute 1.11.4, `manifest.json`). Drei Regeln, deren Verletzung **still** ist: (1) jede Zeile braucht `control` ODER `render` — eine Zeile ohne Regler überspringt der native Renderer wortlos; (2) bedingte Zeilen werden **weggelassen**, nie per `visible` versteckt (das wertet er nicht aus); (3) `display()` nie intern aufrufen (Deprecation ab 1.13) — der Rebuild liegt in `renderImperative()`. Wächter: `tests/obsidian/settings-definitions.test.ts` (Unit) und der Abschnitt „Deklarative Settings-API" in `scripts/gui-smoke.ts` (gegen echtes 1.13). **Wer hier einen ESLint-Override stundet, macht `npm run lint` für genau die Store-Warnung blind, die er stundet** — beim Ablösen gehört er im selben Zug entfernt, sonst ist die Ablösung unbelegt.
