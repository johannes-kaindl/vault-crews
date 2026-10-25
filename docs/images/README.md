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
| `hero.png` | hero | README.md, README.de.md | Das Run-Panel **während** eines Laufs: der Live-Text des Modells wächst mit, der aufklappbare „Thinking"-Bereich steht offen, die Statuszeile nennt den laufenden Task. Das ist der Unterschied zu einem Fortschrittsbalken — man sieht, **was** das Modell gerade schreibt. Aufgenommen wird das ganze Fenster in einer Höhe von 640 px (`HERO_HOEHE` in `scripts/shots.ts`): in einem 900 px hohen Fenster besteht unter dem Inhalt ein Drittel der Bildhöhe aus leerer Fläche (readme_lint `image-whitespace`, 41 % identische Zeilen gegen höchstens 25 %), in 640 px rückt die Statuszeile mit dem Abbrechen-Knopf nach oben und nichts wird abgeschnitten. |
| `settings-endpoints.png` | feature | README.md, README.de.md | Die Endpunkt-Liste in den Einstellungen: eine Zeile mit URL, API-Schlüssel und Modell-Auswahl, die Rolle daneben („aktiv"), darunter die Kontextlänge des Modells („Context: …"), darunter die Fähigkeiten des gewählten Modells. Belegt die Aussage der README, dass lokale und gehostete Anbieter in **einer** Fallback-Liste stehen dürfen. |
| `crew-file.png` | feature | README.md, README.de.md | Eine Crew als das, was sie ist: eine Notiz. Frontmatter mit `crew-kind: team`, `write_scope` und den Tasks, darunter die erklärende Prosa. Zeigt, dass eine Crew editierbar ist, ohne das Plugin zu verlassen. |
| `run-log.png` | feature | README.md, README.de.md | Das Protokoll eines Laufs (`run.md`) im Lesemodus: Status je Task, Dauer, Modell, und die Liste der geschriebenen Dateien. Belegt die Nachvollziehbarkeit, die die README zusagt. |
| `history-undo.png` | feature | README.md, README.de.md | Der Verlauf-Tab des Panels mit dem letzten Lauf und dem **Rückgängig**-Knopf. Das Sicherheitsnetz ist das zweite Verkaufsargument des Plugins und stand bisher nur als Behauptung in der README. |

## Was der Lauf voraussetzt

- **Kein Modell nötig:** `hero.png`, `run-log.png` und `history-undo.png` entstehen aus einem **echten Lauf des Plugins** (Orchestrator, Aufgabenkette, Streaming-Antwortbereich, Protokoll, Verlauf) gegen den zentralen LLM-Stub (`tools/obsidian-cdp/llm-stub.ts`), den `scripts/shots.ts` selbst startet und beendet: die Oberfläche ist echt, nur die Worte des Modells sind festgelegt (ein Gedankengang und ein Digest, mit festem Takt). Es braucht weder LM Studio noch CORS. `--modell <id>` nennt nur den Modellnamen, den der Stub meldet und den die Zeile im Bild zeigt (Standard `qwen/qwen3.6-35b-a3b`).
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

⚠️ **Die Aufnahme läuft in einer Zweitinstanz, nie in der regulären Instanz.** Obsidian ist geteilte
Infrastruktur: ein `quit` oder `activate` trifft die Instanz, an der möglicherweise eine andere Session
arbeitet. Das Startrezept (eigenes `--user-data-dir`, eigener Port, aktuelle `.asar`,
Vertrauensdialog) steht im Kopf von `tools/obsidian-cdp/cdp.ts`, in der `AGENTS.md` des Dachs
(§ Staging-Vaults) und in der README der Brücke (§ Zweitinstanz und Obsidian-CLI) und wird hier nicht
kopiert; der Kopf von `scripts/shots.ts` hat die Befehle für dieses Repo.

```bash
# STAGING_VAULTS_DIR muss gesetzt sein (~/.zshenv; kanonischer Ort steht in
# obsidian-plugins/AGENTS.md § Staging-Vaults). Bewusst ohne Beispielwert:
# ein zweiter Ort in der Doku gabelt die Konvention.
npm run build && npm run shots -- --setup         # Vault aus dem Fixture bauen

#   Zweitinstanz starten (Rezept s. o.), Aufnahme-Vault einmalig als vertrauenswürdig markieren
npm run shots -- --port <port>
npm run shots -- --port <port> --only hero.png    # ein Bild nachziehen
npm run shots -- --list                           # Vertrag anzeigen
```

Das Fenster muss dabei **sichtbar und unverdeckt** sein — macOS meldet ein verdecktes
Fenster als occluded, Chromium macht daraus `visibilityState: "hidden"`, und der DOM misst
dann nichts. Das Rezept holt das verbundene Fenster selbst nach vorn (`requireVisible`).

## Was die Aufnahme über das Plugin ergeben hat

Eine Bebilderung ist der ehrlichste Funktionstest, den ein Plugin bekommt — sie verlangt,
dass ein Feature wirklich durchläuft. Drei Befunde aus diesem Lauf:

1. **Der Live-Ticker ist ohne CORS stumm** (gemessen an LM Studio: der Strom läuft über einen `XMLHttpRequest` aus dem Obsidian-Renderer, der `Origin: app://obsidian.md` sendet, und der Preflight wird ohne CORS abgelehnt; das Plugin fällt auf den Non-Streaming-Pfad zurück, der Lauf gelingt, das Panel zeigt bis zum Schluss „Waiting for output…“). Das Plugin dokumentiert das bisher nur
   für Ollama (`OLLAMA_ORIGINS`); für LM Studio gilt es genauso, und nichts im Panel sagt
   es dem Nutzer — dort steht nur „Waiting for output…", bis der Lauf fertig ist.
2. **Das Panel merkt nicht, wenn eine Crew-Datei dazukommt.** Es baut seine Liste beim
   Öffnen; eine neu angelegte Crew erscheint erst, wenn man das Panel schließt und wieder
   öffnet. Der Aufnahme-Treiber erzwingt den Neuaufbau deshalb selbst.
3. **Eine ungültige Crew wird im Panel gelistet, aber ohne Hinweis.** Sie startet und
   scheitert dann im Preflight mit „The team or agent file has an error — check its
   fields"; der konkrete Fehler steht erst im Lauf-Protokoll. Das ist absichtlich so
   (die Zeile soll startbar bleiben), kostet aber beim Schreiben einer Crew einen Umweg.
