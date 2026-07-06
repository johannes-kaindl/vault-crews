# Vault Crews

Autonome lokale LLM-Agenten-Teams („Crews") auf deinem Obsidian-Vault laufen lassen,
angetrieben von einem lokalen [LM Studio](https://lmstudio.ai/)-Modell — mit einer
deterministischen, orchestrator-geführten Pipeline und einem Snapshot-Sicherheitsnetz
unter jedem Lauf.

Lokale Modelle werden als schwache, unzuverlässige Ausführende behandelt. Der
Orchestrator entscheidet *Ablauf, Pfade und Schreibzugriffe*; das Modell entscheidet
ausschließlich *Inhalte*, innerhalb enger, schema-validierter Verträge. Jede Ausgabe
wird erst eingeschränkt, dann verifiziert, bevor sie den Vault berührt.

## Funktionen

- **Deterministische Pipeline statt freiem Agenten-Loop.** Eine Crew („Team") ist eine
  Folge von genau drei Task-Arten — `collector` (deterministisches Sammeln von
  Kontext), `llm` (eine Chat-Completion gegen einen schema-validierten Vertrag) und
  `actions` (deterministisches Anwenden einer validierten Aktionsliste). Das Modell
  steuert nie den Ablauf und berührt den Vault nie direkt.
- **Constrain-then-verify vor jedem Schreibzugriff.** Jede LLM-Ausgabe wird extrahiert,
  gegen ein eingebautes, versioniertes Schema validiert und quellgebunden — ein Modell
  kann keinen Pfad und keinen Enum-Wert erfinden, der nicht schon im gesammelten
  Material existierte. Ein Reparatur-Durchlauf (ein Retry) fängt kaputtes JSON ab.
- **Git-freies Snapshot-Undo, ein Klick.** Bevor ein Lauf eine Notiz berührt, wird ihr
  Vor-Lauf-Stand (Copy-on-Write) in einen versteckten Speicher über die
  Obsidian-Vault-/Adapter-API gesnapshottet. „Undo last run" stellt geänderte Notizen
  aus dem Snapshot wieder her und verschiebt vom Lauf erzeugte Notizen in den Papierkorb
  — kein Git-Repository nötig, funktioniert in jedem Vault.
- **Zwei mitgelieferte Beispiel-Crews**, per Befehl installierbar: **Task-Triage**
  (prüft Backlog-TaskNotes, schlägt Metadaten-Korrekturen nur auf weichen Feldern vor)
  und **Daily-Briefing** (fasst offene Aufgaben in die heutige Tagesnotiz).
- **Volle Beobachtbarkeit, im Vault.** Jeder Lauf schreibt eine menschenlesbare
  `run.md` (Frontmatter + Task-Detail, Bases-kompatibel) und eine maschinenlesbare
  `state.json`, plus ein mitgeliefertes `runs.base`-Dashboard.
- **Crash-Recovery.** Ein verwaister Lock + eine noch als `running` markierte
  `state.json` werden beim nächsten Plugin-Laden erkannt, mit einer empfohlenen Aktion:
  den Lauf abschließen (Teilstand behalten — über den write-ahead-Snapshot undo-bar).
- Englische/deutsche Oberfläche.

## Voraussetzungen

- **Nur Desktop** (`isDesktopOnly: true` — das Plugin ist um ein lokal gehostetes,
  über HTTP bereitgestelltes LLM herum gebaut, ein Desktop-Workflow).
- **[LM Studio](https://lmstudio.ai/)** lokal laufend, mit seiner OpenAI-kompatiblen
  API standardmäßig auf `http://localhost:1234` (konfigurierbar, mit Fallback-Liste).
- **CORS in LM Studio aktivieren** (LM Studio → Settings → Developer → *Enable CORS*).
  Das Plugin streamt die Modellausgabe via `XMLHttpRequest` aus Obsidians
  Renderer-Prozess (`requestUrl` kann nicht streamen); ohne CORS lehnt LM Studio diese
  Anfragen ab und jeder Lauf verweigert im Preflight mit „endpoint-unreachable".
- **Kein Git-Repository nötig.** Das Undo-Netz ist ein Pro-Lauf-Snapshot über die
  Obsidian-Vault-/Adapter-API und funktioniert in jedem Vault — mit oder ohne Git.
  (Frühere Versionen verlangten ein Git-Repo; ab 0.2.0 entfällt diese Pflicht.)

## Installation

**Aus den Community-Plugins (sobald gelistet):** **Einstellungen → Community-Plugins →
Durchsuchen** öffnen, nach **Vault Crews** suchen, installieren und aktivieren.

**Vor der Listung — via BRAT** ([Beta Reviewers Auto-update
Tool](https://github.com/TfTHacker/obsidian42-brat)):

1. Das **BRAT**-Community-Plugin aus Obsidians Plugin-Browser installieren.
2. In BRATs Einstellungen „Add beta plugin" wählen und auf dieses Repository zeigen
   (`https://codeberg.org/jkaindl/vault-crews`).
3. **Vault Crews** unter Community-Plugins aktivieren.

**Nach dem Aktivieren** den Befehl **„Install example crews"** ausführen, um `_crews/`
(Standard-Root, in den Einstellungen konfigurierbar) mit den Beispiel-Teams
Task-Triage und Daily-Briefing, ihren Agenten und dem `runs.base`-Dashboard zu
befüllen. Installierte Dateien werden von einem zweiten Lauf nie überschrieben — danach
frei editierbar.

## Sicherheitsmodell

- **`write_scope`-Whitelist pro Team, plus eine feste Denylist, die immer gewinnt.**
  Jedes Team deklariert die vault-relativen Globs, in die es schreiben darf. Eine feste
  Denylist — `.obsidian/**`, `.git/**`, `_crews/**`, `_vaultrag/**`, Dotfiles —
  überschreibt jede Whitelist bedingungslos; Crews können ihre eigene Konfiguration nie
  lesen oder schreiben (kein Self-Triggering, kein Prompt-Injection-Pfad in die
  Plugin-Steuerung).
- **Ein Snapshot unter jedem Schreibzugriff — Ein-Klick-Undo.** Vor jedem Notiz-Write
  wird der Vor-Lauf-Inhalt write-ahead in einen versteckten Pro-Lauf-Speicher (unter
  `.obsidian/plugins/vault-crews/undo/`) erfasst. Auch ein fehlgeschlagener oder
  abgebrochener Lauf mit Teilschreibungen bleibt vollständig undo-bar. **Undo last run**
  stellt geänderte Notizen wieder her und verschiebt vom Lauf erzeugte in den Papierkorb
  (nie Hard-Delete), zeigt vor der Bestätigung genau, was rückgängig gemacht wird (Team,
  Zeit, Dateien), und warnt, wenn eine Notiz nach dem Lauf editiert wurde, statt sie
  still zu überschreiben.
- **Schreib- und Wanduhr-Limits.** `max_writes` pro Lauf (team-konfigurierbar, gedeckelt
  durch ein plugin-weites Maximum), ein hartes Pro-Notiz-Größenlimit, ein
  LLM-Call-Budget und ein Wanduhr-Watchdog (Standard 10 Minuten), der einen entlaufenen
  Lauf abbricht (dessen Teilschreibungen gesnapshottet und undo-bar bleiben) statt
  endlos zu laufen.
- **Konsistenz-Schwelle.** Werden mehr als 50 % der vorgeschlagenen Aktionen eines Tasks
  abgelehnt oder sind stale, scheitert der ganze Task, statt einen semantisch
  inkonsistenten Teilstand anzuwenden; unterhalb der Schwelle werden einzelne Aktionen
  übersprungen und geloggt.
- **Constrain-then-verify, zweifach.** Stufe 1 (`output-validator`) validiert das rohe
  Modell-JSON gegen ein eingebautes Schema und bindet jeden Pfad/Enum-Wert an das
  tatsächlich gesammelte Material. Stufe 2 (`action-executor`) prüft jede Aktion erneut
  gegen Whitelist/Denylist, erlaubte Aktionstypen, erlaubte Frontmatter-Schlüssel und
  einen Content-Hash-Staleness-Guard — unmittelbar vor dem Schreiben, unabhängig von
  Stufe 1.

## Netzwerk-Offenlegung

- Das Plugin spricht mit genau einem Netzwerk-Endpunkt: deiner lokalen LM-Studio-Instanz
  (Standard `http://localhost:1234`, konfigurierbar mit Fallback-Liste). Kein anderer
  Host wird je kontaktiert, keine Telemetrie, keine Analytics, keine Update-Pings.
- Port 8080 ist standardmäßig denylistet (oft von anderen lokalen Single-Consumer-
  Modellservern belegt) — ein Default-*Setting*, kein hartcodiertes Verhalten,
  änderbar.
- Keine Shell-Ausführung und kein direkter Dateisystem-Zugriff: das Undo-Netz schreibt
  seine Snapshots ausschließlich über die Obsidian-Vault-/Adapter-API, nie via
  `child_process` oder `node:fs`.

## V1-Einschränkungen

Dokumentiert statt stillschweigend fehlend — die vollständige Liste steht in der
englischen [`README.md`](README.md) (Abschnitt „V1 limitations"). Kurzfassung: kein
Mid-Run-Transport-Retry (V2, ein fehlgeschlagener Lauf ist immer sicher + billig
wiederholbar); Crash-Recovery geht von einem Gerät aus; `verboseLogging` ist reserviert,
aber noch nicht verdrahtet; Ports werden einmalig beim Laden gebaut (Settings-Änderung
braucht Plugin-Reload); Abbruch ist kooperativ und das Panel ist darüber ehrlich.

## Lizenz

AGPL-3.0-or-later — siehe [`LICENSE`](LICENSE) für den vollständigen Text.
