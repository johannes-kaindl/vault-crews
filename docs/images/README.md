# Aufnahme-Vertrag der README-Bilder

Was welches Bild zeigen muss — und wie es entsteht. Die Bilder werden **nicht von Hand
geklickt**, sondern von `scripts/shots.ts` gegen ein laufendes Obsidian aufgenommen
(`npm run shots`). Ändert sich die Oberfläche, wird das Bild neu aufgenommen, nicht
nachgezeichnet.

Bild-Standard (Klassen, Breiten, Budgets): `_docs/readme/readme-spec.json` im Workspace des
Maintainers. Prüfung: `npm run shots:check`.

## Die Bilder

| Datei | Klasse | referenziert von | muss zeigen |
|---|---|---|---|
| `hero.png` | hero | README.md, README.de.md | Das Run-Panel **während** eines Laufs: der Live-Text des Modells wächst mit, der aufklappbare „Thinking"-Bereich steht offen, die Statuszeile nennt den laufenden Task. Das ist der Unterschied zu einem Fortschrittsbalken — man sieht, **was** das Modell gerade schreibt. |
| `settings-endpoints.png` | feature | README.md, README.de.md | Die Endpunkt-Liste in den Einstellungen: eine Zeile mit URL, API-Schlüssel und Modell-Auswahl, die Rolle daneben („aktiv"), darunter die Fähigkeiten des gewählten Modells. Belegt die Aussage der README, dass lokale und gehostete Anbieter in **einer** Fallback-Liste stehen dürfen. |
| `crew-file.png` | feature | README.md, README.de.md | Eine Crew als das, was sie ist: eine Notiz. Frontmatter mit `crew-kind: team`, `write_scope` und den Tasks, darunter die erklärende Prosa. Zeigt, dass eine Crew editierbar ist, ohne das Plugin zu verlassen. |
| `run-log.png` | feature | README.md, README.de.md | Das Protokoll eines Laufs (`run.md`) im Lesemodus: Status je Task, Dauer, Modell, und die Liste der geschriebenen Dateien. Belegt die Nachvollziehbarkeit, die die README zusagt. |
| `history-undo.png` | feature | README.md, README.de.md | Der Verlauf-Tab des Panels mit dem letzten Lauf und dem **Rückgängig**-Knopf. Das Sicherheitsnetz ist das zweite Verkaufsargument des Plugins und stand bisher nur als Behauptung in der README. |

## Was der Lauf voraussetzt

- **Ein erreichbarer LLM-Endpunkt** unter `http://localhost:1234` (LM Studio).
  `hero.png`, `run-log.png` und `history-undo.png` zeigen einen **echten** Lauf — ohne
  Modell gibt es sie nicht. Das ist Absicht: ein nachgestellter Panel-Zustand würde den
  eigenen Eingriff dokumentieren, nicht das Plugin.
- **CORS muss im LM-Studio-Server an sein** (`lms server start --cors`) — sonst gibt es
  `hero.png` nicht. Der Live-Ticker läuft über einen `XMLHttpRequest` **aus dem Obsidian-
  Renderer**, und der sendet zwingend `Origin: app://obsidian.md`; ohne CORS lehnt LM
  Studio schon den Preflight ab (gemessen: `OPTIONS` → 400). Das Plugin fällt dann auf den
  Non-Streaming-Pfad zurück, der über den Hauptprozess läuft und **keinen** Origin sendet:
  der Lauf gelingt, das Panel zeigt bis zum Schluss „Waiting for output…". Nach der
  Aufnahme **zurückstellen** (`lms server start` ohne `--cors`) — sonst dokumentiert das
  Bild eine Umgebung, die es beim Leser nicht gibt.
- **Modellwahl** (`--modell <id>`, Standard `qwen/qwen3.6-35b-a3b`): Nicht jede Maschine
  lädt jedes Modell — LM Studios Guardrail lehnt einen JIT-Load bei knappem Speicher ab,
  und ein Bild, das daran scheitert, sagt nichts über das Plugin. Für `hero.png` braucht
  es ein **denkendes** Modell, das lange genug arbeitet (aufgenommen mit
  `qwen/qwen3.6-27b`); für `run-log.png`/`history-undo.png` ein **schnelles**, das
  durchläuft (aufgenommen mit `google/gemma-4-e2b`, 18 s).
- Aufnahmesprache ist **Englisch** (App-weit, `localStorage["language"]`), Beispieldaten
  sind generisch — keine echten Personen, Firmen oder Nummern.

## Fixture

`docs/images/fixture/` ist der ganze Inhalt des Aufnahme-Vaults:

- `notes/Notes/` — fünf kurze, erfundene Arbeitsnotizen zu einem Scheduler-Umzug, dazu
  eine Übersichtsnotiz mit dem Marker-Block, in den die Crew schreibt.
- `notes/_crews/teams/` und `notes/_crews/agents/` — die Crew „Reading digest".
  **Die Unterordner sind Pflicht:** das Plugin sucht Teams unter `<crewRoot>/teams` und
  Agenten unter `<crewRoot>/agents`. Flach abgelegte Crew-Dateien erscheinen im Panel
  gar nicht — es meldet dann „No crews yet", ohne den Grund zu nennen. Sie sammelt die Notizen,
  lässt das Modell einen Dreisatz-Digest schreiben und ersetzt damit **genau einen**
  Abschnitt. `write_scope` erlaubt eine Datei, `max_writes` ist 1.
- `obsidian/` — Vault-Konfiguration: nur dieses Plugin aktiv, keine fremden Ribbon-Icons
  im Bild, Properties ausgeblendet.

## Reproduktion

```bash
export STAGING_VAULTS_DIR="$HOME/StagingVaults"   # einmalig
npm run build && npm run shots -- --setup         # Vault aus dem Fixture bauen

osascript -e 'quit app "Obsidian"'
open -a Obsidian --args --remote-debugging-port=9222
#   ... den Aufnahme-Vault öffnen und einmalig als vertrauenswürdig markieren

osascript -e 'tell application "Obsidian" to activate' && npm run shots
npm run shots -- --only hero.png                  # ein Bild nachziehen
npm run shots -- --list                           # Vertrag anzeigen
```

Das Fenster muss dabei **sichtbar und unverdeckt** sein — macOS meldet ein verdecktes
Fenster als occluded, Chromium macht daraus `visibilityState: "hidden"`, und der DOM misst
dann nichts. Deshalb `activate` und Lauf in einem Befehl.

## Was die Aufnahme über das Plugin ergeben hat

Eine Bebilderung ist der ehrlichste Funktionstest, den ein Plugin bekommt — sie verlangt,
dass ein Feature wirklich durchläuft. Drei Befunde aus diesem Lauf:

1. **Der Live-Ticker ist ohne CORS stumm** (s. o.). Das Plugin dokumentiert das bisher nur
   für Ollama (`OLLAMA_ORIGINS`); für LM Studio gilt es genauso, und nichts im Panel sagt
   es dem Nutzer — dort steht nur „Waiting for output…", bis der Lauf fertig ist.
2. **Das Panel merkt nicht, wenn eine Crew-Datei dazukommt.** Es baut seine Liste beim
   Öffnen; eine neu angelegte Crew erscheint erst, wenn man das Panel schließt und wieder
   öffnet. Der Aufnahme-Treiber erzwingt den Neuaufbau deshalb selbst.
3. **Eine ungültige Crew wird im Panel gelistet, aber ohne Hinweis.** Sie startet und
   scheitert dann im Preflight mit „The team or agent file has an error — check its
   fields"; der konkrete Fehler steht erst im Lauf-Protokoll. Das ist absichtlich so
   (die Zeile soll startbar bleiben), kostet aber beim Schreiben einer Crew einen Umweg.
