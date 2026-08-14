# Vault Crews

Autonome lokale LLM-Agenten-Teams („Crews") auf deinem Obsidian-Vault laufen lassen,
angetrieben von einem lokalen Modell ([LM Studio](https://lmstudio.ai/) oder
[Ollama](https://ollama.ai/)) — mit einer deterministischen, orchestrierten Pipeline und
einem Snapshot-Netz unter jedem Lauf.

Lokale Modelle werden als schwache, unzuverlässige Ausführende behandelt. Der
Orchestrator entscheidet über *Ablauf, Pfade und Schreibvorgänge*; das Modell entscheidet
ausschließlich über *Inhalt*, innerhalb enger, schema-validierter Verträge. Jede Ausgabe
wird eingeschränkt und dann geprüft, bevor sie deinen Vault berührt.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/gitea/v/release/jkaindl/vault-crews?gitea_url=https%3A%2F%2Fgit.jkaindl.de&label=release)](https://git.jkaindl.de/jkaindl/vault-crews/releases)
[![Obsidian](https://img.shields.io/badge/obsidian-1.8.7%2B%20·%20nur%20Desktop-purple)](https://obsidian.md)

> **Hinweis:** Diese Übersetzung folgt der englischen [`README.md`](README.md).
> Bei Abweichungen gilt die englische Fassung.

## Funktionen

- **Deterministische Pipeline, keine freilaufende Agenten-Schleife.** Eine Crew („Team")
  ist eine Folge aus genau drei Aufgabenarten — `collector` (deterministisches Sammeln
  von Kontext), `llm` (eine Chat-Completion gegen einen schema-validierten Vertrag) und
  `actions` (deterministisches Anwenden einer geprüften Aktionsliste auf den Vault). Das
  Modell steuert nie den Ablauf und fasst den Vault nie direkt an.
- **Einschränken, dann prüfen — vor jedem Schreibvorgang.** Jede LLM-Ausgabe wird
  extrahiert, gegen ein eingebautes, versioniertes Schema validiert und an die Quelle
  gebunden — ein Modell kann keinen Dateipfad und keinen Enum-Wert erfinden, den es im
  gesammelten Material nicht schon gab. Ein Reparaturlauf (ein Wiederholungsversuch)
  fängt kaputtes JSON ab.
- **Git-freies Snapshot-Undo, ein Klick.** Bevor ein Lauf eine Notiz anfasst, wird ihr
  Zustand vor dem Lauf per Copy-on-Write in einen versteckten Speicher gesichert (über
  die Vault-/Adapter-API von Obsidian). „Letzten Lauf rückgängig machen" stellt geänderte
  Notizen aus dem Snapshot wieder her und verschiebt im Lauf angelegte Notizen in den
  Papierkorb — kein Git-Repository nötig, funktioniert in jedem Vault.
- **Zwei mitgelieferte Beispiel-Crews**, per Befehl installierbar: **Task-Triage**
  (sichtet Backlog-TaskNotes und schlägt Metadaten-Korrekturen nur auf weichen Feldern
  vor) und **Daily-Briefing** (fasst offene Aufgaben in der heutigen Tagesnotiz
  zusammen).
- **Volle Nachvollziehbarkeit, im Vault.** Jeder Lauf schreibt eine menschenlesbare
  `run.md` (Frontmatter + Detail je Aufgabe, Bases-kompatibel) und eine
  maschinenlesbare `state.json`, dazu ein mitgeliefertes `runs.base`-Dashboard.
- **Absturz-Wiederaufnahme.** Ein verwaistes Lock zusammen mit einer `state.json`, die
  noch auf `running` steht, wird beim nächsten Laden des Plugins erkannt — mit einer
  empfohlenen Aktion: den Lauf abschließen (die Teiländerungen bleiben, sie sind über
  den Write-Ahead-Snapshot weiterhin rückgängig zu machen).
- Oberfläche auf Englisch und Deutsch.

## Voraussetzungen

- **Nur Desktop** (`isDesktopOnly: true` — das Plugin ist um ein lokal gehostetes,
  über HTTP angesprochenes LLM herum gebaut, und das ist ein Desktop-Ablauf).
- **Ein lokaler LLM-Server:** [LM Studio](https://lmstudio.ai/) (Standard-Port `1234`)
  oder [Ollama](https://ollama.ai/) (Standard-Port `11434`) mit einer
  OpenAI-kompatiblen API. Der Endpunkt ist in den Plugin-Einstellungen konfigurierbar;
  einfach die URL eintragen (z.B. `http://localhost:1234/v1` für LM Studio oder
  `http://localhost:11434/v1` für Ollama). Du kannst mehrere Endpunkte auflisten (einen
  pro Zeile), das Plugin nimmt bei jedem Preflight den ersten erreichbaren. Keine
  Anbieterauswahl nötig — Kontextlänge und Fähigkeiten werden automatisch erkannt.
- **CORS auf deinem LLM-Server aktivieren.** Das Plugin streamt die Modellausgabe per
  `XMLHttpRequest` aus Obsidians Renderer-Prozess (`requestUrl` kann nicht streamen).
  **LM Studio:** Einstellungen → Developer → *Enable CORS*. **Ollama:** die
  Umgebungsvariable `OLLAMA_ORIGINS=<deine-obsidian-app-url>` setzen (optional; ohne sie
  fällt das Plugin auf den nicht-streamenden Modus zurück, Ergebnisse kommen trotzdem
  an).
- **Kein Git-Repository nötig.** Das Undo-Netz ist ein Snapshot je Lauf über die
  Vault-/Adapter-API von Obsidian und funktioniert damit in jedem Vault — Git-Repo oder
  nicht. (Frühere Fassungen setzten ein Git-Repo voraus; seit 0.2.0 ist diese
  Anforderung weg.)

## Installation

**Aus den Community-Plugins (sobald gelistet):** **Einstellungen → Community-Plugins →
Durchsuchen** öffnen, nach **Vault Crews** suchen, installieren und aktivieren.

**Vorher — über BRAT** ([Beta Reviewers Auto-update
Tool](https://github.com/TfTHacker/obsidian42-brat)):

1. Das Community-Plugin **BRAT** über den Plugin-Browser von Obsidian installieren.
2. In den BRAT-Einstellungen „Add beta plugin" wählen und auf dieses Repository zeigen
   (`https://git.jkaindl.de/jkaindl/vault-crews`).
3. **Vault Crews** unter Community-Plugins aktivieren.

**Nach dem Aktivieren** den Befehl **„Install example crews"** ausführen, um `_crews/`
(Standard-Wurzel, in den Einstellungen änderbar) mit den Beispiel-Teams Task-Triage und
Daily-Briefing, ihren Agenten und dem `runs.base`-Dashboard zu befüllen. Installierte
Dateien werden von einem zweiten Lauf nie überschrieben — bearbeite sie danach frei.

## Verwendung

1. **Deinen lokalen LLM-Server starten** (LM Studio oder Ollama) mit aktiviertem CORS,
   und ein Modell laden. Das Plugin löst bei jedem Preflight den ersten erreichbaren
   Endpunkt auf.
2. **Einmal „Install example crews" ausführen** — das befüllt die Crew-Wurzel
   (standardmäßig `_crews`) mit den Teams Task-Triage und Daily-Briefing, ihren Agenten
   und dem `runs.base`-Dashboard.
3. **Das Crews-Panel öffnen** (Ribbon-Icon oder **Open crews panel**). Es listet die
   gefundenen Teams und zeigt während eines Laufs die aktuelle Aufgabe samt laufender
   Token-Zahlen.
4. **Einen Lauf starten** mit **Run crew…** und der Auswahl eines Teams, oder über den
   team-eigenen Befehl **Run crew: &lt;Name&gt;**, den jedes Team unter seinem eigenen
   Namen registriert.
5. **Beim Arbeiten zusehen.** Das Panel zeigt den Status jeder Aufgabe (wartend,
   laufend, ok, fehlgeschlagen, übersprungen, veraltet). **Abort current run** fordert
   einen Stopp an, der zwischen Aufgaben und innerhalb des Modell-Streams beachtet wird.
6. **Das Protokoll lesen.** Jeder Lauf schreibt eine `run.md` (menschenlesbar,
   Bases-kompatibel) und daneben eine `state.json`; **Open last run log** springt
   dorthin, und `runs.base` listet alle Läufe auf einmal.
7. **Bei Bedarf rückgängig machen.** **Undo last run** zeigt, was es wiederherstellen
   würde (Team, Zeit, Dateien), und fragt vorher nach — geänderte Notizen kommen aus dem
   Snapshot zurück, im Lauf angelegte Notizen wandern in den Papierkorb.

Eigene Teams und Agenten zu schreiben ist schlichtes Markdown im Vault — siehe
[Eigene Crews schreiben](#eigene-crews-schreiben) unten.

## Konfiguration

**Einstellungen → Community-Plugins → Vault Crews**, in vier Gruppen:

| Einstellung | Standard | Bedeutung |
|---|---|---|
| **Endpunkte** | `http://localhost:1234/v1` | Einer pro Zeile; genutzt wird der erste erreichbare je Lauf. **Check connections** prüft jede Zeile und meldet abgelehnt / unbekannter Host / Zeitüberschreitung / keine LLM-API getrennt |
| **Gesperrte Endpunkte** | `localhost:8080`, `127.0.0.1:8080` | Werden nie kontaktiert — der Standard hält das Plugin von einem Port fern, den andere lokale Modell-Server üblicherweise belegen. Eine Einstellung, nicht fest verdrahtet |
| **Standard-Modell** | *(leer)* | Modellname, der bei jedem Aufruf mitgeht; **Load models** füllt ein Auswahlfeld vom erreichbaren Endpunkt |
| **Crew-Wurzelordner** | `_crews` | Vault-relativer Ordner mit Agenten, Teams und Lauf-Protokollen |
| **Max. Schreibvorgänge pro Lauf** | 10 | Plugin-weite Obergrenze; der `max_writes`-Wert eines Teams kann nur darunter liegen |
| **Wanduhr-Limit** | 10 Minuten | Bricht einen davonlaufenden Lauf ab; seine Teiländerungen bleiben gesichert und rückgängig zu machen |
| **Tiefe der Undo-Historie** | 15 | Wie viele Lauf-Snapshots aufbewahrt werden, bevor die ältesten wegfallen |
| **Zeitlimit je Aufruf** | 300 s | Hartes Limit pro Modellaufruf — großzügig, weil das Laden eines Modells auf Zuruf dauern kann |
| **Stillstands-Limit** | 60 s | Bricht ab, wenn kein neues Token mehr kommt; wird erst nach dem ersten Token geprüft, damit Laden nie als Stillstand missverstanden wird |
| **Ausführliches Logging** | aus | Reserviert — die Einstellung wird gespeichert, aber noch von nichts gelesen (siehe V1-Grenzen) |

Endpunkt- und Zeitlimit-Einstellungen werden einmal beim Laden des Plugins gelesen;
Änderungen wirken erst nach Deaktivieren und erneutem Aktivieren.

## Funktionsweise

Ein Lauf ist ein **Orchestrator, der eine feste Pipeline abgeht** — kein Modell, das
entscheidet, was als Nächstes kommt. Jedes Team ist eine Folge aus genau drei
Aufgabenarten:

1. **`collector`** — deterministisches Sammeln. Code liest den Vault, nicht das Modell,
   und stellt das Material zusammen (etwa `tasknotes.query` über einen Ordner, optional
   samt Notiz-Inhalt).
2. **`llm`** — genau eine Chat-Completion, die gegen das Schema antwortet, das der
   `output:`-Block der Aufgabe festlegt. Das Modell sieht nur das gesammelte Material
   und erzeugt nur Inhalt — nie einen Pfad, nie eine Ablaufentscheidung.
3. **`actions`** — deterministisches Anwenden. Die geprüfte Aktionsliste wird von Code
   auf den Vault angewendet.

Zwischen Modell und Notizen liegen **zwei unabhängige Prüfungen**. Stufe 1
(`output-validator`) parst die rohe Antwort, validiert sie gegen ein eingebautes,
versioniertes Schema und bindet jeden Pfad und jeden Enum-Wert an das tatsächlich
gesammelte Material zurück — ein vom Modell erfundener Pfad hat nichts, woran er binden
könnte, und wird verworfen. Ein Reparaturversuch fängt kaputtes JSON ab. Stufe 2
(`action-executor`) prüft jede Aktion unmittelbar vor dem Schreiben erneut, unabhängig
von Stufe 1: gegen die `write_scope`-Allowlist und die feste Denylist, gegen die
erlaubten Aktionstypen und Frontmatter-Schlüssel, und gegen einen Inhalts-Hash — hast du
die Datei nach dem Sammeln bearbeitet, wird diese Aktion übersprungen statt deine
Änderung zu überschreiben. Fällt mehr als die Hälfte der Aktionen einer Aufgabe weg,
scheitert die Aufgabe, statt einen halb konsistenten Zustand anzuwenden.

Schreibvorgänge werden **write-ahead** gesichert: der Inhalt einer Notiz vor dem Lauf
wandert über die Vault-/Adapter-API von Obsidian in einen versteckten Speicher je Lauf,
bevor sie angefasst wird. Deshalb bleibt selbst ein abgestürzter oder abgebrochener Lauf
vollständig rückgängig zu machen, und deshalb braucht es kein Git-Repository.

## Sicherheitsmodell

- **`write_scope`-Allowlist je Team, plus eine feste Denylist, die immer gewinnt.** Jedes
  Team erklärt die vault-relativen Globs, in die es schreiben darf. Eine feste Denylist —
  `.obsidian/**`, `.git/**`, `_crews/**`, `_vaultrag/**`, Dotfiles — sticht jede
  Allowlist bedingungslos; Crews können ihre eigene Konfiguration nie lesen oder
  schreiben (kein Selbstauslösen, kein Prompt-Injection-Pfad in die Plugin-Steuerung).
- **Ein Snapshot unter jedem Schreibvorgang — Undo mit einem Klick.** Vor dem Schreiben
  jeder Notiz wird ihr Inhalt vor dem Lauf write-ahead in einen versteckten Speicher je
  Lauf gesichert (unter `.obsidian/plugins/vault-crews/undo/`). Selbst ein
  fehlgeschlagener oder abgebrochener Lauf mit Teiländerungen bleibt vollständig
  rückgängig zu machen. **Undo last run** stellt geänderte Notizen wieder her und
  verschiebt im Lauf angelegte in den Papierkorb; es zeigt vor der Bestätigung genau,
  was es rückgängig macht (Team, Zeit, Dateien) — und warnt, wenn eine Notiz nach dem
  Lauf bearbeitet wurde, statt sie stillschweigend zu überschreiben. Im Lauf angelegte
  Notizen gehen in Obsidians Papierkorb, nie in ein hartes Löschen.
- **Schreib- und Zeitgrenzen.** `max_writes` pro Lauf (je Team konfigurierbar, gedeckelt
  durch eine plugin-weite Obergrenze), eine harte Größengrenze je Notiz, ein Budget für
  LLM-Aufrufe und ein Wanduhr-Wächter (Standard 10 Minuten), der einen davonlaufenden
  Lauf abbricht (seine Teiländerungen bleiben gesichert und rückgängig zu machen), statt
  ewig weiterzulaufen.
- **Konsistenz-Schwelle.** Werden mehr als 50 % der vorgeschlagenen Aktionen einer
  Aufgabe verworfen oder sind sie veraltet, scheitert die ganze Aufgabe, statt einen
  semantisch inkonsistenten Teilzustand anzuwenden; unterhalb dieser Schwelle werden
  einzelne Aktionen übersprungen und protokolliert.
- **Einschränken und prüfen, zweimal.** Stufe 1 (`output-validator`) validiert das rohe
  Modell-JSON gegen ein eingebautes Schema und bindet jeden Pfad und Enum-Wert an das
  Material, das für diese Aufgabe tatsächlich gesammelt wurde. Stufe 2
  (`action-executor`) prüft jede Aktion erneut gegen Pfad-Allowlist/-Denylist, erlaubte
  Aktionstypen, erlaubte Frontmatter-Schlüssel und einen Inhalts-Hash gegen Veralten
  (hast du die Datei seit dem Sammeln bearbeitet, wird genau diese Aktion übersprungen,
  nie still überschrieben) — unmittelbar vor dem Schreiben, unabhängig von Stufe 1.

## Netzwerk-Offenlegung

- Das Plugin spricht mit genau einem Netzwerk-Endpunkt: deinem lokalen LLM-Server
  (standardmäßig LM Studio `http://localhost:1234/v1` oder Ollama
  `http://localhost:11434/v1`, vom Nutzer konfigurierbar). Kein anderer Host wird je
  kontaktiert, keine Telemetrie, keine Analytics, keine Update-Pings.
- Port 8080 steht standardmäßig auf der Denylist (üblicherweise von anderen lokalen
  Einzelnutzer-Modellservern belegt) — das ist eine *Einstellung* mit diesem Standard,
  kein fest verdrahtetes Verhalten, und lässt sich ändern.
- Keine Shell-Ausführung und kein direkter Dateisystemzugriff: das Undo-Netz schreibt
  seine Snapshots ausschließlich über die Vault-/Adapter-API von Obsidian, nie über
  `child_process` oder `node:fs`.

## V1-Einschränkungen

Dokumentiert, statt stillschweigend zu fehlen:

- **Kein Transport-Retry und kein erneutes Auflösen des Endpunkts mitten im Lauf.**
  Stirbt LM Studio oder bricht die Verbindung während des Streams ab, scheitert der
  aktuelle Aufruf und der Lauf endet als `failed`, mit gesicherten Teiländerungen; das
  Plugin versucht innerhalb eines Laufs weder neu zu verbinden noch den Endpunkt neu
  aufzulösen. Das ist bewusst aufgeschoben — ein gescheiterter Lauf ist immer sicher
  (Undo-Snapshot + vollständiges Protokoll) und billig zu wiederholen: `section.replace`
  ist idempotent, und `note.create`/Patch-Semantik verweigern eine doppelte Anwendung.
  Dieselbe Crew nach einem Neustart von LM Studio einfach erneut laufen zu lassen ist
  der vorgesehene Weg.
- **Die Absturz-Wiederaufnahme setzt ein einzelnes Gerät voraus.** Die Erkennung
  verwaister Läufe (altes Lock + `state.json` noch auf `running`) ist für „Obsidian ist
  auf diesem Rechner mitten im Lauf abgestürzt" gebaut. Ein Vault, der über zwei
  gleichzeitig laufende Obsidian-Desktops synchronisiert wird (etwa per iCloud/Syncthing,
  während beide offen sind), ist für V1 ausdrücklich außerhalb des Umfangs — siehe
  Entwurfsrisiko #8.
- **Rohe LLM-Ausgabe bei Validierungsfehlern landet unter `runs/<id>/artifacts/`.**
  Scheitert die Ausgabe einer Aufgabe an Schema- oder Quellbindungs-Validierung, wird die
  rohe Modellantwort nach `artifacts/<taskId>-1.txt` geschrieben; scheitert auch der eine
  Reparaturversuch, kommt dessen Antwort nach `artifacts/<taskId>-2.txt`. Das speist den
  Test-Fixture-Bestand echter kaputter Modellausgaben und wird unterhalb des
  Lauf-Verzeichnisses geschrieben — es zählt nie als Vault-Schreibvorgang, rührt
  `max_writes` nicht an und wird nicht für das Undo gesichert. Erfolgreiche Läufe
  schreiben gar keine Artefakte.
- **`verboseLogging` (Einstellungen → Erweitert) ist reserviert, nicht verdrahtet.** Die
  Einstellung existiert und wird gespeichert, aber derzeit liest sie niemand; ein
  vollständiges Mitschreiben der Rohausgabe *jedes* Aufrufs (Erfolg wie Fehlschlag) —
  über die Fehlerfall-Aufzeichnung in `artifacts/` hinaus — ist nicht umgesetzt.
- **Das Fehlerprotokoll öffnet `run.md` oben, nicht bei der gescheiterten Aufgabe.**
  „View failure" öffnet die Protokolldatei des Laufs über
  `workspace.getLeaf().openFile()` ohne flüchtigen Scroll-Zustand — du landest oben in
  der Notiz und scrollst selbst zum passenden `##`-Abschnitt.
- **Ports werden einmal beim Laden des Plugins gebaut.** Der LM-Studio-Endpunkt sowie die
  Einstellungen für Aufruf- und Stillstands-Zeitlimit werden einmal in `onload()`
  gelesen, um den `LlmClient` zu bauen; ein geänderter Endpunkt oder Zeitwert wirkt sich
  auf eine bereits laufende Plugin-Instanz nicht aus. Nach solchen Änderungen das Plugin
  deaktivieren und wieder aktivieren (oder Obsidian neu starten).
- **Ein Lauf lässt sich nur kooperativ abbrechen — und das Panel sagt das ehrlich.**
  „Cancel" / „Abort current run" setzt das Abbruch-Flag, das zwischen Aufgaben und
  innerhalb des LLM-Streams beachtet wird; greift es, bekommst du `status: aborted` mit
  Teiländerungen (rückgängig zu machen). Mit einem schnellen lokalen Modell kann ein
  ganzer Lauf in 1–2 s fertig sein, ein Klick also nach dem letzten Prüfpunkt landen und
  der Lauf normal enden — das ist *richtig so* (die Arbeit war schon getan), kein
  verlorener Klick. Das Panel bildet das wahrheitsgemäß ab: während des Abbruchs zeigt es
  „Abort requested…", und war der Lauf vorher fertig, sagt es „der Lauf war vor dem
  Abbruch fertig — es wurde nichts abgebrochen", statt in einem Spinner zu erstarren.
  Einen Mechanismus, bereits fertige Arbeit wegzuwerfen, gibt es bewusst nicht.

## Eigene Crews schreiben

Eine Crew ist Markdown im Vault: ein **Team** (`crew-kind: team`) als Pipeline aus
`collector → llm → actions`, plus **Agent**-Notes (`crew-kind: agent`, System-Prompt
im Body). Die mitgelieferten Crews (Command „Install example crews") sind editierbare
Beispiele — kopiere und passe sie an.

### Output-Vokabular (`output:`)

Ein `llm`-Task legt sein Ausgabeformat über einen `output:`-Block fest:

- **`frontmatter.set`** — das Modell schlägt Frontmatter-Werte für Quell-Notizen vor.
  `allowed_keys` beschränkt, welche Felder gesetzt werden dürfen. Pfade sind an das
  Quellmaterial gebunden (keine Halluzination); die strukturelle Enum-Erzwingung
  bindet Werte an die im Vault vorhandenen Ist-Werte, greift aber erst, wenn das Feld
  im Ordner bereits belegte Werte hat — beim allerersten Lauf (noch keine Werte, keine
  Wertetabelle) kommt eine Wertebeschränkung nur aus Instruktion und Agent-Prompt.
  ```yaml
  output:
    family: frontmatter.set
    allowed_keys: [tags, kategorie]
  ```
- **`section.write`** — das Modell schreibt Markdown-Text, der per `section.replace`
  in das `target` des nachgelagerten `actions`-Tasks geschrieben wird. Optional
  `max_chars` (Default 16000).
  ```yaml
  output:
    family: section.write
  ```

Die älteren Namen `output_schema: triage-v1` / `briefing-v1` bleiben als Kurzform gültig.

### Inhalt lesen (`include_content`)

Standardmäßig liefert `tasknotes.query` nur Frontmatter. Für Crews, die den
Notiz-**Text** brauchen (Tagger, Zusammenfasser), setze `include_content: true`:

```yaml
collector: tasknotes.query
params:
  folder: Notizen
  where_missing: [tags]
  include_content: true
```

### Schreib-Sicherheit (`write_scope`)

`write_scope` ist eine Glob-Allowlist: eine Crew darf nur dort schreiben. Setze sie
so eng wie möglich — und lass `collector`-`folder` und `write_scope` auf denselben
Ordner zeigen, sonst werden Vorschläge außerhalb der Schreibfreigabe verworfen. Das
Plugin-Limit „Max. Schreibvorgänge pro Lauf" deckelt zusätzlich jeden `max_writes`-Wert.

## Lizenz

AGPL-3.0-or-later — der vollständige Text steht in [`LICENSE`](LICENSE).
