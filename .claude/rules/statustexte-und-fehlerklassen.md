---
paths:
  - "src/obsidian/settings.ts"
  - "src/core/types.ts"
  - "src/core/run-log.ts"
  - "src/i18n/**"
  - "src/main.ts"
  - "src/obsidian/panel-view-model.ts"
  - "tests/i18n-error-kinds.test.ts"
  - "src/vendor/kit-obsidian/endpoint-status-text.ts"
---

# Statusklassen und Fehlerklassen — Nähte zwischen Kit, Core und `t()`

Gotchas zu den Sätzen, die aus Kit-Aufzählungen und Core-Typen über `t()` in die Oberfläche gelangen.

- **Seit obsidian-kit 0.56.0 (Welle 18, 2026-10-12) kommen die Sätze zu den Statusklassen und Eingabe-Hinweisen aus dem Kit:** `endpointStatusText`/`endpointWarningText` (`src/vendor/kit-obsidian/endpoint-status-text.ts`, über `LLM_CONNECTION_STRINGS_EN/DE.endpointList` in `src/obsidian/settings.ts`), EN und DE. Die eigene Zuordnung (`endpoint-labels.ts`, die Wörterbuchzeilen `settings.endpoint.*`) und der Wächter `tests/i18n-status-keys.test.ts` sind weg. **Der Wächter ist jetzt der Kit-Test `tests/endpoint-status-text.test.ts` in obsidian-kit** (je Marke und Sprache vorhanden und verschieden von „unknown“, mit Mutationsprobe). Die Begründung bleibt: ein Schlüssel, der still ausfällt, sieht in der Oberfläche wie ein plausibler String aus. Wer eine Kit-Aufzählung an `t()` anschließt, zieht einen Wächter mit (**CORE-TEST-04**); das lebende Muster ist `tests/i18n-error-kinds.test.ts` in diesem Repo (`Record<…, true>` plus Abgleich gegen die Quelle) und der Kit-Test `tests/endpoint-status-text.test.ts`.

- **Dieselbe Naht existiert ein zweites Mal — bei den Fehlerklassen (seit 2026-08-18).** `ErrorKind` ist ein Core-Typ, die Sätze dazu führt die Obsidian-Schicht über `t("notice.errorKind." + kind)` (`main.ts`, `panel-view-model.ts`). Ein neuer Kind ohne Satz fällt genauso still auf den rohen Schlüssel zurück. Wächter: `tests/i18n-error-kinds.test.ts` — `Record<ErrorKind, true>` (Typ-Ebene) plus ein Abgleich gegen `ERROR_KINDS` aus `run-log.ts`, weil run.md und Oberfläche sonst auseinanderlaufen können, ohne dass irgendwo etwas bricht. Beide Stufen sind per Gegenprobe belegt (TS2741 bzw. „EN fehlt: notice.errorKind.…"). **Wer einen `ErrorKind` hinzufügt, fasst drei Stellen an: `types.ts`, `run-log.ts` und beide Sprachblöcke in `strings.ts`** — der Wächter erzwingt genau das.
