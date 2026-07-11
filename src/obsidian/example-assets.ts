/** Beispiel-Crews (Task 18): Inhalte als TS-String-Konstanten, weil esbuild keine
 *  .md/.base-Dateien bündelt — dies ist die Laufzeit-Quelle, die install-examples.ts
 *  in den Vault schreibt. `assets/examples/**` ist der Klartext-Spiegel derselben
 *  Inhalte (byte-identisch, von tests/obsidian/install-examples.test.ts geprüft) —
 *  bei Änderungen BEIDE Stellen pflegen. Deutsche Prompts, da der Referenz-Vault
 *  (Pallas) Deutsch ist. Reale Pallas-Pfade: Aufgaben-Ordner `10_Aufgaben`, Daily-
 *  Note-Ordner `30_Chronos/10_Tage` (periodic-notes/daily-notes.json, Format
 *  YYYY-MM-DD). */

export const TRIAGE_ANALYST_AGENT = `---
crew-kind: agent
name: Triage-Analyst
temperature: 0.1
max_tokens: 2048
thinking: off
---
Du bist ein nüchterner Task-Triage-Analyst für einen persönlichen Obsidian-Vault.
Du bewertest Aufgaben-Notizen anhand ihres Frontmatters und schlägst NUR
Metadaten-Korrekturen an weichen Feldern vor (priority, kontext, projekt,
period). Du erfindest nichts, du löschst nichts, du änderst niemals title,
status oder type. Bei Unsicherheit schlägst du NICHTS vor.
`;

export const BRIEFING_AUTOR_AGENT = `---
crew-kind: agent
name: Briefing-Autor
temperature: 0.2
max_tokens: 1536
thinking: off
---
Du bist der Autor eines kurzen, ruhigen Tages-Briefings für einen persönlichen
Obsidian-Vault. Du bekommst eine Liste offener Aufgaben (Titel, Status,
Priorität, Kontext, Projekt und – falls vorhanden – Fälligkeitsdatum) als
JSON. Du schreibst daraus knappes Markdown mit GENAU drei Abschnitten:
„Heute fällig“, „Überfällig“, „Eine nächste Handlung“. Du nutzt ausschließlich
Titel aus dem Quellmaterial, du erfindest keine Aufgaben. Ist ein Abschnitt
leer, schreibst du einen kurzen, beruhigenden Satz statt einer leeren Liste.
„Eine nächste Handlung“ nennt genau EINE konkrete, sofort ausführbare
Aufgabe – deine Wahl, keine Liste.
`;

export const TASK_TRIAGE_TEAM = `---
crew-kind: team
name: Task-Triage
version: 1
description: Prüft Backlog-TaskNotes auf fehlende oder inkonsistente Metadaten und schlägt Korrekturen an weichen Feldern vor.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "10_Aufgaben/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: 10_Aufgaben
      where: { status: [backlog] }
      limit: 25
      fields: [title, status, priority, kontext, projekt, period]
  - id: analyse
    kind: llm
    agent: triage-analyst
    inputs: [collect]
    instruction: |
      Bewerte jede Aufgabe: fehlende priority? leerer kontext? fehlendes
      projekt oder period, obwohl thematisch naheliegend? Schlage pro Aufgabe
      höchstens eine Frontmatter-Korrektur vor. Bei Unsicherheit: nichts
      vorschlagen.
    output_schema: triage-v1
    on_error: abort
  - id: apply
    kind: actions
    inputs: [analyse]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [priority, kontext, projekt, period]
---
## Task-Triage

Prüft den Backlog in \`10_Aufgaben/\` und schlägt Korrekturen an **weichen**
Feldern vor (priority, kontext, projekt, period) – niemals an status oder
type (strukturell erzwungen über \`allowed_keys\` im \`apply\`-Task, Spec §4.3).

Nach der Installation frei editierbar: Ordner, Feld-Liste, Instruktion,
\`limits.max_writes\` (das Plugin-Standardlimit aus den Einstellungen deckelt
jeden Wert nach oben, siehe Abweichung unten).

**Abweichung von Spec §2.3:** \`limits.max_writes\` steht hier auf 10 statt der
im Spec-Beispiel genannten 15, weil das Plugin-Standardlimit (Einstellungen →
Sicherheit → „Max. Schreibvorgänge pro Lauf“) ebenfalls bei 10 liegt. Ein
frisch installiertes Team soll nicht schon bei der eigenen Preflight-
Validierung an diesem Limit scheitern. Wer mehr als 10 Schreibvorgänge pro
Lauf braucht, hebt zuerst das Plugin-Limit an und danach dieses Feld.
`;

export const DAILY_BRIEFING_TEAM = `---
crew-kind: team
name: Daily-Briefing
version: 1
description: Fasst offene Aufgaben zu einem kurzen Tages-Briefing zusammen und schreibt es in die heutige Daily Note.
trigger: manual
limits:
  max_writes: 1
write_scope:
  - "30_Chronos/10_Tage/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: 10_Aufgaben
      where: { status: [backlog, aktiv] }
      sort: priority
      limit: 30
      fields: [title, status, priority, kontext, projekt, frist]
  - id: briefing
    kind: llm
    agent: briefing-autor
    inputs: [collect]
    instruction: |
      Du bekommst offene Aufgaben (Backlog + Aktiv, keine erledigten) mit
      Titel, Status, Priorität, Kontext, Projekt und – falls vorhanden –
      Fälligkeitsdatum (frist). Schreibe ein kurzes Tages-Briefing in Markdown
      mit GENAU diesen drei Abschnitten:

      ## Heute fällig
      ## Überfällig
      ## Eine nächste Handlung

      Ordne jede Aufgabe nach bestem Ermessen zu: ein frist-Datum in der
      Vergangenheit gehört zu „Überfällig"; eine Aufgabe ohne frist, aber mit
      Status „aktiv", gehört zu „Heute fällig". Ist ein Abschnitt leer,
      schreibe einen kurzen, beruhigenden Satz statt einer leeren Liste.
      „Eine nächste Handlung" nennt genau EINE konkrete, sofort ausführbare
      Aufgabe aus der Liste.
    output_schema: briefing-v1
    on_error: abort
  - id: apply
    kind: actions
    inputs: [briefing]
    allowed_actions: [section.replace]
    target: "30_Chronos/10_Tage/{{today}}.md"
    create_if_missing: true
---
## Daily-Briefing

Fasst die offenen Aufgaben aus \`10_Aufgaben/\` zu einem kurzen Briefing
zusammen und schreibt es per \`section.replace\` in die heutige Daily Note
(\`30_Chronos/10_Tage/{{today}}.md\`, Format \`YYYY-MM-DD\` – Pallas-Vault-
Konvention aus \`periodic-notes\`/\`daily-notes.json\`). Der Block steht zwischen
den Markern \`<!-- crew:daily-briefing -->\` … \`<!-- /crew:daily-briefing -->\`.
Dank \`create_if_missing: true\` wird die heutige Daily Note angelegt, falls sie
noch nicht existiert (nur der Marker-Block, kein Template). Ein Undo entfernt die
so erzeugte Note wieder (Papierkorb).

**Bewusste Vereinfachung ggü. Spec §9 (Wortlaut „Analyst-JSON → Autor-
Markdown“):** Diese Beispiel-Crew nutzt EINEN llm-Task (Agent
\`briefing-autor\`) statt getrennter Analyst- und Autor-Rollen. Bei einem
einzelnen kurzen Briefing pro Tag bringt der Zwischenschritt wenig
zusätzlichen Nutzen, kostet aber einen weiteren Modellaufruf (und damit
Zeit + Fehleroberfläche).

**Bewusste Vereinfachung von „heute fällig + überfällig“ (wörtlich Spec
§9):** Der reale \`tasknotes.query\`-Collector (\`src/core/collectors.ts\`) kennt
keinen Datums-Bereichsfilter – \`where\` matcht nur Key→Slug-Werteliste, kein
\`>\`/\`<\` auf Datumswerten. Außerdem wird zur Laufzeit ausschließlich das
\`target\`-Feld eines \`actions\`-Tasks mit \`{{today}}\` expandiert; die
\`instruction\` eines \`llm\`-Tasks ist statischer Text ohne Datums-Platzhalter –
dem Modell kann das aktuelle Datum also nicht zuverlässig mitgegeben werden.
Statt eine nicht vorhandene Collector-Fähigkeit vorzutäuschen, holt \`collect\`
alle offenen Aufgaben (Backlog + Aktiv) samt optionalem \`frist\`-Feld, und
\`briefing-autor\` ordnet sie nach bestem Ermessen den drei Abschnitten zu
(siehe Instruktion oben). Wer harte Datumsgrenzen braucht, kann das Team nach
der Installation um eigene Logik erweitern (z. B. einen \`actions\`-Vor-Task,
der nach Datum vorfiltert).

**Abweichung von Spec-§2.3-Analogie \`max_writes: 15\`:** Hier \`max_writes: 1\`
(genau die eine Daily Note) – bewusst enger als das Plugin-Standardlimit von
10, weil dieses Team strukturell nie mehr als eine Datei schreibt.
`;

export const RUNS_BASE = `filters:
  and:
    - note["crew-kind"] == "run"
formulas:
  fehlerklasse: if(error_kind != null, error_kind, "—")
properties:
  team:
    displayName: Team
  status:
    displayName: Status
  writes:
    displayName: Writes
  llm_calls:
    displayName: LLM-Calls
  duration_s:
    displayName: Dauer (s)
  model:
    displayName: Modell
  formula.fehlerklasse:
    displayName: Fehlerklasse
  error_task:
    displayName: Fehler-Task
  commit:
    displayName: Commit
  started:
    displayName: Gestartet
views:
  - type: table
    name: 🤖 Alle Läufe
    order:
      - file.name
      - team
      - status
      - writes
      - llm_calls
      - duration_s
      - model
      - formula.fehlerklasse
      - commit
      - started
    sort:
      - property: started
        direction: DESC
  - type: table
    name: ⚠️ Braucht Aufmerksamkeit
    filters:
      and:
        - or:
            - status == "failed"
            - status == "refused"
            - status == "aborted"
    order:
      - file.name
      - team
      - status
      - formula.fehlerklasse
      - error_task
      - started
    sort:
      - property: started
        direction: DESC
  - type: table
    name: ✅ Erfolgreich
    filters:
      and:
        - or:
            - status == "ok"
            - status == "partial"
    order:
      - file.name
      - team
      - status
      - writes
      - duration_s
      - started
    sort:
      - property: started
        direction: DESC
`;
