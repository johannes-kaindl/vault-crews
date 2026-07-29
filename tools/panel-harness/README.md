# Panel-Harness — die echte Run-Panel-View im Browser

Lädt `src/obsidian/panel.ts` **unverändert** in einen Chromium-Tab, mit dem echten
`styles.css`, und speist sie mit einem Token-Strom in der Rate eines gemessenen
Laufs. Chromium ist derselbe Renderer, auf dem Obsidian läuft — deshalb zeigt das
Harness, was Unit-Tests nicht zeigen können: ob Text unter dem CSS **sichtbar** ist,
ob er wächst, ob er mitscrollt und ob ein Zustand ein Neuzeichnen übersteht.

Entstanden am 2026-07-30, als der Live-Streaming-Think-Bereich visuell abgenommen
werden sollte, ohne Obsidian anzufassen. Fand dabei einen Bug, den 383 Unit-Tests
nicht hatten: der aufgeklappte Think-Bereich schnappte beim ersten Content-Token
wieder zu (Fix `09af687`).

## Starten

```sh
npx esbuild tools/panel-harness/harness.ts --bundle --format=esm --target=chrome120 \
  --alias:obsidian=./tools/panel-harness/obsidian-shim.ts \
  --outfile=tools/panel-harness/harness.js
python3 -m http.server 8899          # aus dem Repo-Root
open http://127.0.0.1:8899/tools/panel-harness/index.html
```

Der Alias ersetzt den `obsidian`-Import durch `obsidian-shim.ts` (Obsidians
DOM-Helper auf echten DOM-Knoten + eine minimale `ItemView`).

## Parameter

| Query | Wirkung | Default |
|---|---|---|
| `think` | Anzahl Think-Chunks | `2275` (gemessen) |
| `thinkMs` | Dauer der Think-Phase in ms | `46800` (gemessen) |
| `speed` | Zeitraffer-Faktor | `1` |

Die Defaults sind der real gemessene Lauf der `thinking-demo`-Crew gegen
`qwen/qwen3.6-35b-a3b`. Für schnelle Durchläufe: `?think=140&thinkMs=5000`.

## Sonden in der Konsole

- `probe()` — Zeichenzahl, Sichtbarkeit, Scrollposition und `open`-Zustand der Live-Knoten
- `startRun()` — Lauf starten, ohne zu klicken
- `openThink()` — Think-Bereich aufklappen

## Grenzen — was das Harness NICHT beweist

- Obsidians eigene Theme-/Layout-CSS (hier stehen nur genäherte CSS-Variablen)
- die Naht zum Host: View-Lifecycle, `metadataCache`, Workspace-Leaves
- **die Vollständigkeit des Shims.** Fehlt darin ein Obsidian-Helfer, bricht der Render
  mit `TypeError` ab und das sieht aus wie ein Fehler im Plugin-Code. Beim ersten Lauf
  genau deshalb die Konsole lesen (`setAttr` fehlte anfangs). Ein grünes Harness ersetzt
  den manuellen Smoke in Obsidian nicht — es macht ihn kurz.
