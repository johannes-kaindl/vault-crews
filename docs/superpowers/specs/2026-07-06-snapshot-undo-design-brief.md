# Design-Brief: Snapshot-/Quarantäne-Undo (0.2.0)

> **Status:** Design-Auftrag für eine frische Session. Empfohlenes Modell: **Opus 4.8, Effort `high`**
> (nicht Ultracode — dies ist ein interaktiver Design-Dialog, kein Fan-out). Erster Schritt in der
> neuen Session: **brainstorming-Skill**, dann Design-Spec ableiten. Fable nur eskalieren, falls sich
> eine Entscheidung als wirklich offen/tastelastig zeigt.

## Ziel

Die aktuelle Undo-Funktion setzt voraus, dass der User-Vault ein **git-Repo** ist: Run-Logs werden
per `child_process`→System-`git` committet, Undo ist `git revert`. Das soll ersetzt werden durch ein
**plugin-eigenes Snapshot-/Quarantäne-Undo** über die **Obsidian-Vault-/Adapter-API** — ohne git.

## Warum (die drei Treiber)

1. **Voller Store-Pass:** `child_process` + node `fs` erzeugen die zwei „Behavior"-Warnings
   (Shell Execution, Direct Filesystem Access), die einen komplett grünen Review-Report verhindern.
   Ohne git fallen beide weg.
2. **Funktioniert für ALLE User:** Die meisten Obsidian-Vaults sind kein git-Repo → das aktuelle
   Sicherheitsnetz greift für die Mehrheit gar nicht.
3. **Besser gescoped + weniger fragil:** `git revert` eines Run-Commits kann unbeteiligte parallele
   Änderungen mitreißen; außerdem gilt die dokumentierte Lesson „dirty Working Tree in Obsidian-
   Plugins → revert/rebase muss stash-wrappen" (eine ganze Fragilitäts-Klasse, die hier verschwindet).

## Harte Rand­bedingung

**Nur Obsidian-Vault-/Adapter-API. Kein `child_process`, kein `node:fs`.** Das ist der ganze Punkt —
jede Lösung, die das wieder einführt, verfehlt das Ziel.

## Vorhandenes Gerüst (wiederverwenden, nicht neu bauen)

- **`src/core/git-plan.ts` → `CommitPlan`**: zählt die von einem Lauf betroffenen Pfade **vorab** auf.
  Ideal, um genau diese Pfade **vor** dem Applizieren zu snapshotten.
- **`src/core/collectors.ts` → `fnv1a`**: Content-Hashing existiert bereits → für „Note wurde seit dem
  Lauf manuell geändert?"-Erkennung nutzen.
- **`src/obsidian/recovery.ts`**: Crash-Recovery-Mechanik → Snapshots + Manifest fügen sich ein.
- **Aktions-Set (`src/core/types.ts`)**: `frontmatter.patch`, `note.create`, `note.append`,
  `section.replace` — **keine Löschung**. Undo ist damit mechanisch einfach: geänderte Notes aus
  Snapshot zurückschreiben, neu erzeugte Notes löschen. Kein Wiederauferstehen gelöschter Dateien.

## Betroffene Dateien (Umbau ist querschnittlich — im Design berücksichtigen)

git-Undo hängt aktuell an: `main.ts`, `core/git-plan.ts`, `core/orchestrator.ts`, `core/ports.ts`,
`core/run-log.ts`, `obsidian/git-port.ts`, `i18n/strings.ts`, `obsidian/recovery.ts`. Das
`RunPanelView`-Verlauf-Tab exponiert den „Undo"-Button (heute = git revert) — der bleibt, aber
verdrahtet gegen den neuen Mechanismus.

## Offene Entscheidungen (Brainstorm-Agenda)

1. **Storage-Ort:** Adapter-Pfad `.obsidian/plugins/vault-crews/undo/<runId>/` (versteckt, nicht im
   Graph/Search indexiert) vs. In-Vault-Ordner. Empfehlung vorab: Adapter-Pfad.
2. **Retention-Policy:** Wie viele Läufe/Snapshots aufheben? Auto-Prune nach N Läufen / X Tagen?
   „Letzter Lauf immer da" für 1-Klick-Undo?
3. **Hash-Konflikt-UX:** Wenn eine Note **nach** dem Lauf, aber **vor** dem Undo manuell geändert wurde
   (erkannt via `fnv1a`): warnen und „trotzdem zurückrollen?" anbieten.
4. **„Bereinigen" vs. „Archivieren":** Snapshot löschen vs. in einen dauerhaften Archiv-Ordner
   verschieben (Ersatz für die permanente git-Historie, die man aufgibt).
5. **`git-port.ts`-Schicksal:** ersatzlos entfernen (Empfehlung — keine doppelte Wartung) vs. optionale
   git-Integration behalten. Wer git-Historie will, fährt git wie immer selbst über den Vault.
6. **Recovery-Integration:** Snapshot VOR Applizieren schreiben → bei Mid-Run-Crash rekonstruierbar.
7. **Settings/UI-Oberfläche:** was im Verlauf-Tab + Settings sichtbar wird (Retention-Knopf, Archiv-
   Zugang). UI-STANDARD.md ist verbindlich.

## Scope & Versionierung

- Dies ist **0.2.0**. Es bündelt die bereits gemachten, noch uncommitteten 0.1.x-Fixes:
  manifest-Punkt + `minAppVersion` 1.8.7, `getLanguage()` statt localStorage, `js-yaml`→`yaml`.
- Erst nach dem 0.2.0-Umbau erneut beim Store einreichen (dann maximal sauberer Report — modulo der
  „Recommendations", die keine Warnings sind).

## Reihenfolge

brainstorming → Design-Spec (`docs/superpowers/specs/2026-07-06-snapshot-undo-design.md`) → Opus-Exec.
