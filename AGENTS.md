# AGENTS.md

Conventions for AI assistants working in this repo.

> **Workspace-Standards (maintainer-lokal):** Die verbindliche Leitkonvention steht in `_docs/CONVENTIONS.md`
> im Multi-Projekt-Workspace des Maintainers, `../../_docs` relativ zu diesem Repo — nicht Teil dieses Repos,
> ignorieren falls im Klon nicht vorhanden. Modell comply-or-explain.

## What this is
Obsidian-Plugin **Vault Crews** (`vault-crews`): autonome lokale LLM-Agenten-Teams
(LM Studio, `localhost:1234`) laufen als deterministische Pipelines auf dem Vault —
collector → llm → actions, constrain-then-verify, ein git-freies Snapshot-Undo pro Lauf
(write-ahead Pre-Images über die Vault-/Adapter-API, kein `child_process`/`node:fs`).

## Historische Spezifikation (eingefroren, weiter gültig als Referenz)

Die V1-Design-Grundlagen liegen im Repo — eingefroren (s. §Memory unten), aber als
Referenz für Architektur-Entscheidungen weiter gültig; **neue SDD-Artefakte gehen ins
Cockpit**, nicht hierher. In dieser Reihenfolge lesen:

1. Spec: `docs/superpowers/specs/2026-07-02-vault-crews-design.md`
2. Interface-Skelett (bindende Pfade/Typen/Signaturen): `docs/superpowers/plans/2026-07-02-vault-crews-v1-interfaces.md`
3. Implementierungsplan (19 Tasks): `docs/superpowers/plans/2026-07-02-vault-crews-v1.md`
   + Detail-Anhänge unter `docs/superpowers/plans/details/`

## Workflow conventions
- **Gate (vor jedem Commit grün):** `npm run gate` = lint + typecheck + test + check:pure.
  Exit-Code prüfen, nicht grep-Ausgabe (grep maskiert Fehlschläge).
- **Tests:** Vitest node-env; Obsidian-Mock via vitest `resolve.alias` →
  `tests/__mocks__/obsidian.ts`. TDD: erst fehlschlagender Test.
- **Commit style:** Conventional Commits + Trailer
  `Co-Authored-By: <Modell> <noreply@anthropic.com>`.
- **Deploy:** `npm run deploy` (Copy nach `$OBSIDIAN_PLUGIN_DIR`), nie Symlink/BRAT als Primärweg.

## Architecture notes (Invarianten + Gotchas)

**Statusklassen kommen aus dem Kit, die Sätze dazu aus diesem Repo — die Naht ist ungesichert
(erledigt 2026-08-17, 0.9.1, bleibt als Begründung stehen).** Der vendorte
`endpoint_diagnostics.ts` führt die Klassen (Kit 0.24.0), dieses Repo formuliert sie selbst
über `t()`. Fällt dabei ein Schlüssel aus, ist das **unsichtbar**: `t()` fällt bei unbekanntem
Schlüssel auf den **Schlüssel** zurück, nicht auf EN — in der Oberfläche stünde
``settings.endpoint.status.unauthorized`` und sähe aus wie ein plausibler String, nicht wie ein
Fehler. Genau das war bis 0.9.1 der Fall, und getroffen wurde ausgerechnet der Fall, für den
die Klasse eingeführt wurde: ein gehosteter Endpunkt mit fehlendem oder falschem API-Schlüssel
(401/403). Gefunden hat es der Consumer-Sweep, nicht das Gate.

**Der Wächter, der das ab jetzt verhindert:** `tests/i18n-status-keys.test.ts` hält ein
`Record<EndpointStatusKind, true>` — bringt ein Kit-Update eine weitere Klasse mit, bricht
der `typecheck:test`, bevor der rohe Schlüssel in die Oberfläche gelangt (per Gegenprobe
belegt: fiktive Klasse eingesetzt → TS2741 an genau dieser Zeile). Wer eine neue
Kit-Aufzählung an `t()` anschließt, zieht diesen Wächter mit. Verbindlich als
**CORE-TEST-04**; Referenz-Implementierung `obsidian-transmute/tests/i18n-status-keys.test.ts`.
- `src/core/**` und `src/vendor/**` importieren NIE `obsidian` (CI-Gate `check:pure`).
  Ports injiziert (`src/core/ports.ts`); Obsidian-Adapter nur in `src/obsidian/`.
- **Vendoring statt git-Deps:** obsidian-kit-Module liegen kopiert in `src/vendor/kit/`
  mit Herkunfts-Header (`vendored from obsidian-kit#0.2.0, <pfad>`). KEINE
  `git+https`-npm-Dependencies — die Community-Review-Sandbox bricht daran
  (LESSONS.md 2026-07-01). Updates manuell nachziehen; Smoke-Tests in
  `tests/vendor/kit.test.ts` pinnen die Verträge.
- **Slug-Schnitt:** `Schema.validate` prüft Slugs und lässt sie stehen;
  das byte-genaue Rück-Mapping auf Emoji-Originale macht der ActionExecutor
  (`ExecutorContext.slugTables`, Stufe-2-Verteidigung).
- **Denylist:** `buildDenylist(configDir)` — configDir wird injiziert
  (`Vault#configDir`, obsidianmd-Lint). `**/.*/**` deckt Inhalte unter
  Dot-Ordnern (Property-Test-Fund).
- **Endpunkte tragen ihren Schlüssel und ihr Modell** (`EndpointConfig[]`, Kit
  `endpoint_config`): es gibt **kein globales Modellfeld** — ein Modellname existiert nur
  auf dem Endpunkt, der ihn in `/v1/models` meldet. Ein Agenten-`model:` gilt, solange der
  aktive Endpunkt es führt, sonst das Modell der Zeile (`resolveTaskModel`). Der Client
  nimmt den ganzen Eintrag (`setEndpoint(cfg)`), nie URL und Schlüssel getrennt: der
  Resolver liefert die **normalisierte** URL, der gespeicherte Eintrag bleibt roh, ein
  Vergleich über die URL greift also bei jedem `/v1`-Suffix daneben.
- **Schlüssel dürfen nie in den Vault:** `redactRunState` läuft an genau einer Stelle
  (`finish*` im Orchestrator, bevor run.md/state.json geschrieben werden und bevor der
  RunResult zurückgeht). Wer eine neue Ausgabe hinzufügt, die Text aus dem Netzweg trägt,
  muss durch dieselbe Stelle.
- **Kit-Zeilen-Editor, zwei Consumer-Pflichten:** `SettingsTab.hide()` MUSS
  `cache.clear()` rufen (sonst bleibt ein einmal als unerreichbar gemessener Endpunkt die
  ganze Sitzung so stehen), und `clientFor` braucht **ausgeschriebene Rückgabetypen** —
  die Options-Signatur ist eine Intersection zweier `probe()`-Formen, ein Objekt-Literal
  ohne Annotation erfüllt keine davon.
- **Live-Token-Streaming braucht CORS am LLM-Server** (gemessen 2026-08-17 bei der
  README-Bebilderung): Der Ticker läuft als `XMLHttpRequest` aus dem Renderer und sendet
  zwingend `Origin: app://obsidian.md`. Ohne CORS lehnt LM Studio schon den Preflight ab
  (`OPTIONS` → 400), das Plugin fällt still auf den Non-Streaming-Pfad über `requestUrl`
  zurück (Hauptprozess, sendet keinen Origin) — der Lauf gelingt, das Panel zeigt bis zum
  Ende „Warte auf Ausgabe …". Für Ollama war das als `OLLAMA_ORIGINS` schon notiert; es
  gilt für **jeden** Anbieter. `lms server start --cors` schaltet es ein.
- **LM Studio / Ollama:** Kontextlänge aus `/api/v0/models` (LM Studio) oder
  `POST /api/show` (Ollama, unter `model_info["<arch>.context_length"]`);
  Thinking-Suppression provider-übergreifend via `suppressParams`
  (`reasoning_effort: "none"` + `enable_thinking: false` + `reasoning_budget: 0`);
  bei Ollama ggf. `OLLAMA_ORIGINS` für Streaming, sonst greift der Non-Stream-Fallback;
  Stall-Timeout erst NACH erstem Token (JIT-TTFB). NIE Port 8080 als Backend
  (OpenClaw-Mono-Consumer-Lock).
- **Kein `json_schema`-API-Modus** (bricht an LM Studio bei Reasoning-Modellen):
  prompt-basiertes JSON + `output-validator`.

## Memory

- **SDD-Artefakte (seit 2026-07-16): Cockpit, nicht Repo** — Specs/Plans/Task-Reports leben im
  Coding-Cockpit des Maintainers (`$VAULT/25_Coding/vault-crews/_SDD/`, CORE-META-14, maintainer-lokal).
  Sie tragen Arbeitskontext (Vault-Pfade, Schwester-Repo-Interna), der in einem public Repo niemandem nützt.
  Das Repo behält die Design-Essenz in dieser Datei + `CHANGELOG.md`.
- **Alt-Bestand:** `docs/superpowers/{specs,plans}/` ist eingefroren — nichts Neues dort ablegen.
- **Nie im Repo:** absolute Pfade außerhalb des Repos (`/Users/…`, Vault-Pfade) — Platzhalter nutzen
  (`$VAULT/…`, `~/…`, repo-relativ). Herkunftsnachweise als Repo-Name + `Datei:Zeile` sind dagegen erwünscht.
  Gate: `scripts/check-no-abs-paths.mjs` (Teil von `npm test`).
- **Memory** (cross-session): `~/.claude/projects/-Users-johannes-Workspace/memory/`
  (Zeiger auf Cockpit); operativer Stand im Coding-Cockpit
  `$VAULT/25_Coding/vault-crews/vault-crews.md` (maintainer-lokal).
- **Session logs:** Cockpit-`_Log/` (SessionEnd-Hook) + remember-Plugin.

## Smoke checklist
Manueller Release-Smoke-Test (Spec §8: „Kein Live-LLM in CI" — dies ist das
Gate danach). Läuft **immer** gegen einen Wegwerf-Klon, **nie** gegen den
echten Vault — `scripts/clone-vault.sh` schreibt/löscht nie im Quell-Vault.
Der Klon muss **kein git-Repo** mehr sein (Snapshot-Undo, 0.2.0).

1. `scripts/clone-vault.sh` (Default: Pallas → `/tmp/vault-crews-smoke`;
   Quelle/Ziel optional als Argumente).
2. Klon in Obsidian öffnen; Plugin-Build hineinkopieren
   (`OBSIDIAN_PLUGIN_DIR=<Klon>/.obsidian/plugins/vault-crews npm run deploy`)
   oder per BRAT gegen den Klon installieren.
3. Command **„Install example crews"** ausführen.
4. **BEIDE** Beispiel-Crews laufen lassen (Task-Triage **und** Daily-Briefing —
   nicht nur eine).
5. **Undo** testen (Panel → Verlauf → Rückgängig): geänderte Notes wieder im
   Vorzustand, vom Lauf erzeugte Notes im Papierkorb. Der Snapshot-Ordner
   `.obsidian/plugins/vault-crews/undo/<runId>/` existiert nach dem Lauf und
   verschwindet nach dem Undo. Zusatz: eine Note **nach** dem Lauf manuell
   editieren, dann Undo → Konfliktwarnung erscheint.
6. **(Optional) Gegen laufendes Ollama testen** (`http://localhost:11434/v1`):
   Endpoint in den Settings eintragen, eine Crew laufen lassen. Ohne `OLLAMA_ORIGINS`
   erscheint kein Live-Token-Ticker (Non-Stream-Fallback), Ergebnis kommt trotzdem.
7. „Abort current run" **mitten in einem Lauf** auslösen — Partial bleibt im
   Vault (undo-bar), run.md zeigt `status: aborted` + `error_kind: aborted`.

## V1 limitations
Kurzfassung von README.md „V1 limitations" — bei Rückfragen dort das Detail:
- Kein Mid-Run-Transport-Retry/Endpoint-Re-Resolve (V2) — ein fehlgeschlagener
  Lauf ist immer sicher (Commit + Log) und dank `section.replace`-Idempotenz +
  Overwrite-Verweigerung billig wiederholbar.
- Crash-Recovery geht von EINEM Gerät aus; zwei gleichzeitig laufende
  Obsidian-Desktops auf demselben gesyncten Vault sind out of scope (Spec §10
  Risiko 8).
- `verboseLogging` (Settings → Advanced) ist reserviert, aber noch nicht
  verdrahtet — nichts liest den Wert.
- „Fehlerstelle ansehen" öffnet `run.md` am Dateianfang (kein Ephemeral-Scroll
  zum fehlgeschlagenen Task).
- Ports (LLM-Endpoint, Timeouts) werden einmalig in `onload()` gebaut —
  Endpoint-/Timeout-Änderungen in den Settings brauchen Plugin-Reload
  (deaktivieren/aktivieren oder Obsidian-Neustart).
- Abbruch ist kooperativ (greift an Task-Grenzen + im LLM-Stream). Schnelle Läufe
  (1–2 s, MoE) können durch sein, bevor der Klick einen Checkpoint trifft → Lauf endet
  `ok` — das ist *korrekt* (Arbeit war fertig), kein verlorener Klick. Das Panel ist
  darüber ehrlich (Run-Panel-UI-Überarbeitung, `feat/run-panel-ui`): Statuszeile zeigt
  „Abbruch angefordert …", und wenn der Lauf zuerst fertig wurde, sagt die Ergebnis-Karte
  „Lauf war schon fertig, bevor der Abbruch griff — nichts abgebrochen". Bewusst KEIN
  Mechanismus, der fertig gerechnete Arbeit verwirft.

## Dach-Kontext (obsidian-plugins)

Dieses Repo liegt unter dem Koordinations-Dach `obsidian-plugins/` (dem Parent-Verzeichnis `..` dieses Repos).
**Vor dem Lösen eines Problems:** `../AGENTS.md` (Kit-first-Regel) und `../REGISTRY.md`
(Lösungs-Registry) prüfen — viele Probleme sind in Nachbar-Plugins oder im
`obsidian-kit` bereits gelöst.

**Vor jeder UI-Arbeit** (Views, Modals, Settings-Tabs, CSS): `../UI-STANDARD.md` ist
verbindlich (Obsidian-nativ first, ein Frontend pro Plugin, nur Theme-CSS-Variablen).
