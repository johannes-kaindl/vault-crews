# Entscheidungen in vault-crews — das Warum

Verdichtete Design-Essenz zu den Regeln im Kern (`AGENTS.md`) und in `.claude/rules/`. Die Herleitungen liegen im Cockpit des Maintainers (CORE-META-14). Vor dem Übernehmen einer Altentscheidung gilt Johannes' Regel: Grund aufsuchen, messen, ob er heute trägt, Ergebnis melden.

## Statusklassen: die Naht zwischen Kit und `t()` (2026-08-17, 0.9.1)

Der Wortlaut stammt aus der `AGENTS.md` vor der Kürzung (Welle 25) und beschreibt den Stand vor Kit 0.56.0; was heute gilt, steht in `.claude/rules/statustexte-und-fehlerklassen.md`.

**Statusklassen kommen aus dem Kit, die Sätze dazu aus diesem Repo — die Naht ist ungesichert (erledigt 2026-08-17, 0.9.1, bleibt als Begründung stehen).** Der vendorte `endpoint_diagnostics.ts` führt die Klassen (Kit 0.24.0), dieses Repo formuliert sie selbst über `t()`. Fällt dabei ein Schlüssel aus, ist das **unsichtbar**: `t()` fällt bei unbekanntem Schlüssel auf den **Schlüssel** zurück, nicht auf EN — in der Oberfläche stünde ``settings.endpoint.status.unauthorized`` und sähe aus wie ein plausibler String, nicht wie ein Fehler. Genau das war bis 0.9.1 der Fall, und getroffen wurde ausgerechnet der Fall, für den die Klasse eingeführt wurde: ein gehosteter Endpunkt mit fehlendem oder falschem API-Schlüssel (401/403). Gefunden hat es der Consumer-Sweep, nicht das Gate.

## Kein `json_schema`-API-Modus

Der Modus bricht an LM Studio bei Reasoning-Modellen. Stattdessen läuft prompt-basiertes JSON mit `output-validator` (constrain-then-verify).

## Vendoring statt Git-Abhängigkeiten

Die Community-Review-Sandbox bricht an `git+https`-npm-Dependencies (Lesson 2026-07-01), deshalb liegen Kit-Module als Kopie unter `src/vendor/`. Das Werkzeug ist das zentrale `kit-sync` im Dach, die Pins stehen in `tools/kit-sync.json`.
