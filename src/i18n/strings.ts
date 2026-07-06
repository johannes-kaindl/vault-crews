// UI-Strings des Plugins (EN kanonisch, DE Übersetzung) — registriert die vendorte
// i18n-Engine (src/vendor/kit/i18n.ts). main.ts (Task 16b) ruft registerI18n() +
// setLang(pickLang(getLanguage())) einmalig im onload auf, VOR addCommand/
// addSettingTab/addRibbonIcon. Panel (Task 17) und Installer (Task 18) importieren
// nur t() aus dem vendorten Modul und verwenden die hier definierten Keys.
//
// Key-Namespaces: cmd.* (Commands) · settings.<gruppe>.* (SettingsTab) ·
// notice.* (Notices, inkl. notice.errorKind.<ErrorKind> für die „eine Handlung"
// aus Spec §7) · undo.* (Bestätigungs-Modal „Undo last run") · panel.* (Run-Panel-
// Vokabular, Task 17) · recovery.* (Crash-Recovery-Modal, Task 17).
import { defineStrings } from "../vendor/kit/i18n";

export const EN: Record<string, string> = {
  // --- Commands (Spec §6.1, sentence-case, keine Default-Hotkeys) -----------
  "cmd.runCrew": "Run crew…",
  "cmd.runCrewNamed": "Run crew: {0}",
  "cmd.abortRun": "Abort current run",
  "cmd.undoLastRun": "Undo last run",
  "cmd.openPanel": "Open crews panel",
  "cmd.openLastRunLog": "Open last run log",
  "cmd.installExamples": "Install example crews",

  // --- Settings — Connection --------------------------------------------------
  "settings.connection.heading": "Connection",
  "settings.connection.endpoints.name": "Endpoints",
  "settings.connection.endpoints.desc":
    "LM Studio server addresses, one per line. Tried in order until one responds.",
  "settings.connection.deniedEndpoints.name": "Denied endpoints",
  "settings.connection.deniedEndpoints.desc":
    "Endpoints that are never used, even if listed above. Port 8080 is included by default because it is reserved for a mono-consumer local server (OpenClaw), which only ever accepts one connection.",
  "settings.connection.defaultModel.name": "Default model",
  "settings.connection.defaultModel.desc":
    "Model id used when a team does not name one. Leave empty to require every team to set its own model.",
  "settings.connection.testConnection.name": "Test connection",
  "settings.connection.testConnection.desc":
    "Pings the endpoints in order and lists the models available on the first one that responds.",
  "settings.connection.testConnection.button": "Test connection",

  // --- Settings — Crews ---------------------------------------------------
  "settings.crews.heading": "Crews",
  "settings.crews.crewRoot.name": "Crew root folder",
  "settings.crews.crewRoot.desc": "Vault-relative folder that holds agents, teams and run logs.",
  "settings.crews.installExamples.name": "Install example crews",
  "settings.crews.installExamples.desc":
    "Adds a starter agent and team so there is something to run right away.",
  "settings.crews.installExamples.button": "Install example crews",

  // --- Settings — Safety ---------------------------------------------------
  "settings.safety.heading": "Safety",
  "settings.safety.maxWrites.name": "Max writes per run",
  "settings.safety.maxWrites.desc":
    "Plugin-wide maximum number of files a single run may write. Teams may set a lower limit in their own file, but never a higher one.",
  "settings.safety.wallClockMinutes.name": "Wall-clock limit (minutes)",
  "settings.safety.wallClockMinutes.desc":
    "Plugin-wide maximum runtime for a single run. The run is aborted once this is exceeded, regardless of the team file.",
  "settings.safety.undoHistoryDepth.name": "Undo history depth",
  "settings.safety.undoHistoryDepth.desc":
    "How many recent runs keep an undo snapshot. Older snapshots are pruned automatically. Snapshots live in a hidden plugin folder, not in your notes.",

  // --- Settings — Advanced -------------------------------------------------
  "settings.advanced.heading": "Advanced",
  "settings.advanced.callTimeoutS.name": "Call timeout (seconds)",
  "settings.advanced.callTimeoutS.desc":
    "Hard timeout per model call. Kept generous by default because just-in-time model loading can take a while.",
  "settings.advanced.stallTimeoutS.name": "Stall timeout (seconds)",
  "settings.advanced.stallTimeoutS.desc":
    "Aborts a call if no new token arrives for this long. Only checked after the first token, so just-in-time model loading is never mistaken for a stall.",
  "settings.advanced.verboseLogging.name": "Verbose logging",
  "settings.advanced.verboseLogging.desc":
    "Log extra detail to the developer console — useful when troubleshooting a run.",

  // --- Notices — connection test / install --------------------------------
  "notice.testConnection.ok": "Connection ok — {0} model(s) available: {1}.",
  "notice.testConnection.failed": "Connection failed — is LM Studio running?",
  "notice.install.ok": "Example crews installed ({0} file(s)).",
  "notice.install.exists": "Example crews are already installed.",
  "notice.install.useCommand": "Use the “Install example crews” command from the command palette.",

  // --- Notices — one per run end (Spec §6.2) ------------------------------
  "notice.run.ok": "{0}: run completed — {1} file(s) written.",
  "notice.run.partial": "{0}: run partially completed — {1} file(s) written.",
  "notice.run.failed": "{0}: run failed — {1}",
  "notice.run.refused": "{0}: run refused — {1}",
  "notice.run.aborted": "{0}: run aborted — {1} file(s) written before stopping.",

  // --- Notices — run-command guard states (main.ts wiring, Task 16b) -------
  "notice.run.inProgress": "A run is already in progress.",
  "notice.run.noActiveRun": "No run is currently active.",
  "notice.run.noTeams": "No crews found — install the example crews first.",
  "notice.run.noLastRun": "No previous run yet — run a crew first.",

  // --- Notices — error-kind reason text (matches core ErrorKind 1:1, Spec §7) —
  // used to fill the "{1}" of notice.run.failed/refused with one actionable line.
  "notice.errorKind.endpoint_unreachable": "Start LM Studio, then run again.",
  "notice.errorKind.model_missing": "Model not found — check the default model or the team's model field.",
  "notice.errorKind.timeout": "The call took too long and was stopped.",
  "notice.errorKind.stalled": "The model stopped producing tokens.",
  "notice.errorKind.invalid_output": "The model's output could not be parsed, even after one repair attempt.",
  "notice.errorKind.context_overflow": "The input was too large for the model's context window.",
  "notice.errorKind.git_refused": "Git refused the commit — check the vault's git repository.",
  "notice.errorKind.crew_invalid": "The team or agent file has an error — check its fields.",
  "notice.errorKind.write_limit": "The write limit for this run was reached.",
  "notice.errorKind.consistency": "Too many proposed changes did not match the source material.",
  "notice.errorKind.aborted": "The run was aborted.",
  "notice.errorKind.io": "A file operation failed unexpectedly.",

  // --- Undo confirmation modal (Snapshot-Undo: Team, Zeitpunkt, Dateien) ------
  "undo.title": "Undo last run?",
  "undo.field.team": "Team",
  "undo.field.time": "Time",
  "undo.field.files": "Files",
  "undo.warnDiscard": "Changed notes revert to their pre-run state and notes the run created are moved to trash — later unsaved edits are discarded.",
  "undo.warnConflict": "{0} file(s) were changed after the run — roll back anyway?",
  "undo.confirmButton": "Undo",
  "undo.logMarker": "> [!warning] This run was undone.",
  "notice.undo.ok": "Undo complete — restored {0} file(s) to the state before the run.",
  "notice.undo.failed": "Undo failed — no changes were made.",

  // --- Run-panel vocabulary (Spec §6.2, Task 17) ---------------------------
  "panel.header.idle": "Crews",
  "panel.header.running": "Task {0}/{1}: {2}",
  "panel.status.waiting": "Waiting",
  "panel.status.running": "Running",
  "panel.status.ok": "Ok",
  "panel.status.failed": "Failed",
  "panel.status.skipped": "Skipped",
  "panel.status.stale": "Stale",
  // Run-level status vocabulary (RunStatus; extends the task-line vocabulary above with
  // the three values a TaskRecord can never have — ok/failed are shared on purpose).
  "panel.status.partial": "Partial",
  "panel.status.aborted": "Aborted",
  "panel.status.refused": "Refused",
  "panel.thinking": "Thinking… {0} tokens",
  "panel.streaming": "Streaming… {0} tokens",
  "panel.cancel": "Cancel",
  "panel.cancelling": "Cancelling…",
  "panel.openLog": "Open log",
  "panel.viewFailure": "View failure",
  "panel.undo": "Undo",
  "panel.nextAction": "Next action",
  "panel.nextAction.ok": "Review the written files, or undo if something looks wrong.",
  "panel.nextAction.partial": "Some steps were skipped — check the log for details.",
  "panel.idle.run": "Run",
  "panel.idle.never": "Never run",
  "panel.done.filesWritten": "{0} file(s) written",
  "panel.done.duration": "{0}s",
  "panel.relative.justNow": "Just now",
  "panel.relative.minutesAgo": "{0}m ago",
  "panel.relative.hoursAgo": "{0}h ago",
  "panel.relative.daysAgo": "{0}d ago",
  // Hub navigation + honest abort UX (Run-Panel-UI-Überarbeitung)
  "panel.title": "Vault Crews",
  "panel.tab.crews": "Crews",
  "panel.tab.history": "History",
  "panel.idle.empty": "No crews yet.",
  "panel.done.back": "Back to overview",
  "panel.statusLine.running": "▶ {0}/{1} · {2}",
  "panel.statusLine.starting": "▶ Starting…",
  "panel.statusLine.aborting": "⏳ Abort requested…",
  "panel.abortNote.aborted": "Aborted before completion.",
  "panel.abortNote.finishedFirst": "The run finished before the abort took effect — nothing was aborted.",
  "panel.history.empty": "No runs yet.",
  "panel.history.crewsHeading": "Per crew",
  "panel.history.crewRow": "{0} — {1} · {2}",

  // --- Crash-recovery modal (Spec §7 "Obsidian-Crash mid-run", Task 17) ----
  "recovery.title": "Recover interrupted run",
  "recovery.finish": "Finish orphaned run (keep partial changes)",
  "recovery.explain":
    "Obsidian closed unexpectedly during a run of “{0}”. Finishing commits everything written so far, so nothing is lost.",
};

export const DE: Record<string, string> = {
  // --- Commands --------------------------------------------------------------
  "cmd.runCrew": "Crew ausführen…",
  "cmd.runCrewNamed": "Crew ausführen: {0}",
  "cmd.abortRun": "Aktuellen Lauf abbrechen",
  "cmd.undoLastRun": "Letzten Lauf rückgängig machen",
  "cmd.openPanel": "Crews-Panel öffnen",
  "cmd.openLastRunLog": "Letztes Lauf-Protokoll öffnen",
  "cmd.installExamples": "Beispiel-Crews installieren",

  // --- Settings — Connection --------------------------------------------------
  "settings.connection.heading": "Verbindung",
  "settings.connection.endpoints.name": "Endpunkte",
  "settings.connection.endpoints.desc":
    "Adressen des LM-Studio-Servers, eine pro Zeile. Werden der Reihe nach probiert, bis einer antwortet.",
  "settings.connection.deniedEndpoints.name": "Gesperrte Endpunkte",
  "settings.connection.deniedEndpoints.desc":
    "Endpunkte, die niemals verwendet werden, selbst wenn sie oben aufgeführt sind. Port 8080 ist standardmäßig gesperrt, weil er für einen Mono-Consumer-Lokalserver (OpenClaw) reserviert ist, der immer nur eine Verbindung gleichzeitig annimmt.",
  "settings.connection.defaultModel.name": "Standardmodell",
  "settings.connection.defaultModel.desc":
    "Modell-Id, die verwendet wird, wenn ein Team keine eigene angibt. Leer lassen, um jedes Team zur eigenen Modell-Angabe zu zwingen.",
  "settings.connection.testConnection.name": "Verbindung testen",
  "settings.connection.testConnection.desc":
    "Probiert die Endpunkte der Reihe nach und listet die Modelle des ersten antwortenden Endpunkts.",
  "settings.connection.testConnection.button": "Verbindung testen",

  // --- Settings — Crews ---------------------------------------------------
  "settings.crews.heading": "Crews",
  "settings.crews.crewRoot.name": "Crew-Wurzelordner",
  "settings.crews.crewRoot.desc": "Vault-relativer Ordner mit Agenten, Teams und Lauf-Protokollen.",
  "settings.crews.installExamples.name": "Beispiel-Crews installieren",
  "settings.crews.installExamples.desc":
    "Legt einen Beispiel-Agenten und ein Beispiel-Team an, damit direkt etwas zum Ausführen da ist.",
  "settings.crews.installExamples.button": "Beispiel-Crews installieren",

  // --- Settings — Safety ---------------------------------------------------
  "settings.safety.heading": "Sicherheit",
  "settings.safety.maxWrites.name": "Max. Schreibvorgänge pro Lauf",
  "settings.safety.maxWrites.desc":
    "Plugin-weites Höchstlimit für Dateien, die ein einzelner Lauf schreiben darf. Teams dürfen in ihrer eigenen Datei ein niedrigeres Limit setzen, aber nie ein höheres.",
  "settings.safety.wallClockMinutes.name": "Zeitlimit (Minuten)",
  "settings.safety.wallClockMinutes.desc":
    "Plugin-weite Höchstlaufzeit für einen einzelnen Lauf. Der Lauf wird abgebrochen, sobald sie überschritten ist — unabhängig von der Team-Datei.",
  "settings.safety.undoHistoryDepth.name": "Undo-Verlauf-Tiefe",
  "settings.safety.undoHistoryDepth.desc":
    "Wie viele der letzten Läufe einen Undo-Snapshot behalten. Ältere werden automatisch geprunt. Snapshots liegen in einem versteckten Plugin-Ordner, nicht in deinen Notizen.",

  // --- Settings — Advanced -------------------------------------------------
  "settings.advanced.heading": "Erweitert",
  "settings.advanced.callTimeoutS.name": "Aufruf-Timeout (Sekunden)",
  "settings.advanced.callTimeoutS.desc":
    "Hartes Timeout pro Modellaufruf. Standardmäßig großzügig, weil Just-in-Time-Laden des Modells etwas dauern kann.",
  "settings.advanced.stallTimeoutS.name": "Stillstand-Timeout (Sekunden)",
  "settings.advanced.stallTimeoutS.desc":
    "Bricht einen Aufruf ab, wenn so lange kein neues Token kommt. Wird erst nach dem ersten Token scharf geschaltet, damit Just-in-Time-Laden nicht als Stillstand gilt.",
  "settings.advanced.verboseLogging.name": "Ausführliches Logging",
  "settings.advanced.verboseLogging.desc":
    "Schreibt zusätzliche Details in die Entwicklerkonsole — hilfreich zur Fehlersuche.",

  // --- Notices — connection test / install --------------------------------
  "notice.testConnection.ok": "Verbindung ok — {0} Modell(e) verfügbar: {1}.",
  "notice.testConnection.failed": "Verbindung fehlgeschlagen — läuft LM Studio?",
  "notice.install.ok": "Beispiel-Crews installiert ({0} Datei(en)).",
  "notice.install.exists": "Beispiel-Crews sind bereits installiert.",
  "notice.install.useCommand": "Nutze den Befehl „Beispiel-Crews installieren“ aus der Befehlspalette.",

  // --- Notices — eine pro Lauf-Ende (Spec §6.2) ---------------------------
  "notice.run.ok": "{0}: Lauf abgeschlossen — {1} Datei(en) geschrieben.",
  "notice.run.partial": "{0}: Lauf teilweise abgeschlossen — {1} Datei(en) geschrieben.",
  "notice.run.failed": "{0}: Lauf fehlgeschlagen — {1}",
  "notice.run.refused": "{0}: Lauf verweigert — {1}",
  "notice.run.aborted": "{0}: Lauf abgebrochen — {1} Datei(en) vor dem Abbruch geschrieben.",

  // --- Notices — Wächter-Zustände der Lauf-Commands (main.ts, Task 16b) ----
  "notice.run.inProgress": "Es läuft bereits ein Lauf.",
  "notice.run.noActiveRun": "Derzeit läuft kein Lauf.",
  "notice.run.noTeams": "Keine Crews gefunden — zuerst die Beispiel-Crews installieren.",
  "notice.run.noLastRun": "Noch kein vorheriger Lauf — zuerst eine Crew ausführen.",

  // --- Notices — Fehlerklassen-Text (1:1 zu core-ErrorKind, Spec §7) ------
  "notice.errorKind.endpoint_unreachable": "LM Studio starten, dann erneut ausführen.",
  "notice.errorKind.model_missing": "Modell nicht gefunden — Standardmodell oder Modell-Feld des Teams prüfen.",
  "notice.errorKind.timeout": "Der Aufruf hat zu lange gedauert und wurde abgebrochen.",
  "notice.errorKind.stalled": "Das Modell hat aufgehört, Token zu erzeugen.",
  "notice.errorKind.invalid_output": "Die Ausgabe des Modells ließ sich auch nach einem Reparatur-Versuch nicht parsen.",
  "notice.errorKind.context_overflow": "Die Eingabe war zu groß für das Kontextfenster des Modells.",
  "notice.errorKind.git_refused": "Git hat den Commit verweigert — Git-Repository der Vault prüfen.",
  "notice.errorKind.crew_invalid": "Die Team- oder Agenten-Datei enthält einen Fehler — Felder prüfen.",
  "notice.errorKind.write_limit": "Das Schreiblimit für diesen Lauf wurde erreicht.",
  "notice.errorKind.consistency": "Zu viele vorgeschlagene Änderungen passten nicht zum Quellmaterial.",
  "notice.errorKind.aborted": "Der Lauf wurde abgebrochen.",
  "notice.errorKind.io": "Eine Dateioperation ist unerwartet fehlgeschlagen.",

  // --- Undo-Bestätigungs-Modal (Snapshot-Undo: Team, Zeitpunkt, Dateien) ------
  "undo.title": "Letzten Lauf rückgängig machen?",
  "undo.field.team": "Team",
  "undo.field.time": "Zeitpunkt",
  "undo.field.files": "Dateien",
  "undo.warnDiscard": "Geänderte Notizen werden auf den Stand vor dem Lauf zurückgesetzt und vom Lauf erzeugte Notizen in den Papierkorb verschoben — spätere ungespeicherte Änderungen gehen verloren.",
  "undo.warnConflict": "{0} Datei(en) wurden nach dem Lauf geändert — trotzdem zurückrollen?",
  "undo.confirmButton": "Rückgängig machen",
  "undo.logMarker": "> [!warning] Dieser Lauf wurde rückgängig gemacht.",
  "notice.undo.ok": "Rückgängig gemacht — {0} Datei(en) auf den Stand vor dem Lauf zurückgesetzt.",
  "notice.undo.failed": "Rückgängig fehlgeschlagen — nichts geändert.",

  // --- Run-Panel-Vokabular (Spec §6.2, Task 17) ----------------------------
  "panel.header.idle": "Crews",
  "panel.header.running": "Task {0}/{1}: {2}",
  "panel.status.waiting": "Wartet",
  "panel.status.running": "Läuft",
  "panel.status.ok": "Ok",
  "panel.status.failed": "Fehlgeschlagen",
  "panel.status.skipped": "Übersprungen",
  "panel.status.stale": "Stale",
  "panel.status.partial": "Teilweise",
  "panel.status.aborted": "Abgebrochen",
  "panel.status.refused": "Verweigert",
  "panel.thinking": "Denkt … {0} Token",
  "panel.streaming": "Streamt … {0} Token",
  "panel.cancel": "Abbrechen",
  "panel.cancelling": "Wird abgebrochen …",
  "panel.openLog": "Log öffnen",
  "panel.viewFailure": "Fehlerstelle ansehen",
  "panel.undo": "Rückgängig",
  "panel.nextAction": "Nächste Handlung",
  "panel.nextAction.ok": "Geschriebene Dateien prüfen oder rückgängig machen, falls etwas nicht stimmt.",
  "panel.nextAction.partial": "Einige Schritte wurden übersprungen — Details im Log.",
  "panel.idle.run": "Ausführen",
  "panel.idle.never": "Noch nie gelaufen",
  "panel.done.filesWritten": "{0} Datei(en) geschrieben",
  "panel.done.duration": "{0}s",
  "panel.relative.justNow": "Gerade eben",
  "panel.relative.minutesAgo": "vor {0} Min.",
  "panel.relative.hoursAgo": "vor {0} Std.",
  "panel.relative.daysAgo": "vor {0} Tg.",
  // Hub-Navigation + ehrliche Abbruch-UX (Run-Panel-UI-Überarbeitung)
  "panel.title": "Vault Crews",
  "panel.tab.crews": "Crews",
  "panel.tab.history": "Verlauf",
  "panel.idle.empty": "Noch keine Crews.",
  "panel.done.back": "Zurück zur Übersicht",
  "panel.statusLine.running": "▶ {0}/{1} · {2}",
  "panel.statusLine.starting": "▶ Startet …",
  "panel.statusLine.aborting": "⏳ Abbruch angefordert …",
  "panel.abortNote.aborted": "Vor Abschluss abgebrochen.",
  "panel.abortNote.finishedFirst": "Lauf war schon fertig, bevor der Abbruch griff — nichts abgebrochen.",
  "panel.history.empty": "Noch keine Läufe.",
  "panel.history.crewsHeading": "Pro Crew",
  "panel.history.crewRow": "{0} — {1} · {2}",

  // --- Crash-Recovery-Modal (Spec §7 „Obsidian-Crash mid-run", Task 17) ----
  "recovery.title": "Unterbrochenen Lauf wiederherstellen",
  "recovery.finish": "Verwaisten Lauf abschließen (Teilstand behalten)",
  "recovery.explain":
    "Obsidian wurde während eines Laufs von „{0}“ unerwartet beendet. Der Abschluss committet alles bisher Geschriebene, damit nichts verloren geht.",
};

/** Registriert EN/DE bei der vendorten i18n-Engine. Einmalig vor dem ersten t()-Aufruf
 *  (main.ts, Task 16b, ruft dies im onload auf, vor addCommand/addSettingTab). */
export function registerI18n(): void {
  defineStrings({ en: EN, de: DE });
}
