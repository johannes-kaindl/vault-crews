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

export const NOTIZ_TAGGER_AGENT = `---
crew-kind: agent
name: Notiz-Tagger
temperature: 0.2
max_tokens: 1024
thinking: off
---
Du bist ein nüchterner Verschlagworter für einen persönlichen Obsidian-Vault. Du
bekommst den Inhalt einzelner Notizen und schlägst pro Notiz 2–4 knappe, thematische
Tags vor: kleingeschrieben, ohne #, je ein Wort oder ein kurzer bindestrich-
getrennter Begriff, und lieferst sie als Liste. Du orientierst dich ausschließlich am
Notiz-Inhalt und erfindest keine Themen. Bei einer inhaltsarmen Notiz schlägst du
weniger oder gar keine Tags vor.
`;

export const REIFEGRAD_TAGGER_AGENT = `---
crew-kind: agent
name: Reifegrad-Tagger
temperature: 0.1
max_tokens: 1024
thinking: off
---
Du bist ein nüchterner Reifegrad-Einschätzer für die Notizen eines persönlichen
Obsidian-Vaults. Du bekommst den Inhalt einzelner Notizen und ordnest jeder GENAU
einen Reifegrad zu: „keim" (loser Gedanke, Stichworte), „wachsend" (in Arbeit,
teilausgeführt) oder „reif" (ausgearbeitet, in sich geschlossen). Du nutzt
ausschließlich diese drei Werte und stützt dich nur auf den vorliegenden Inhalt.
Bei zu wenig Inhalt für eine Einschätzung ordnest du nichts zu.
`;

export const NOTIZ_TAGGER_TEAM = `---
crew-kind: team
name: Notiz-Tagger
version: 1
description: Liest Notizen ohne Tags und schlägt 2–4 thematische Tags aus dem Inhalt vor.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "Notizen/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Notizen
      where_missing: [tags]
      limit: 15
      fields: [tags]
      include_content: true
  - id: tag
    kind: llm
    agent: notiz-tagger
    inputs: [collect]
    instruction: |
      Du bekommst Notizen samt Inhalt, die noch keine Tags haben. Schlage pro
      Notiz 2–4 knappe, thematische Tags **als Liste** vor, abgeleitet ausschließlich
      aus dem Inhalt. Erfinde keine Themen; bei inhaltsarmen Notizen weniger oder keine.
    output:
      family: frontmatter.set
      allowed_keys: [tags]
    on_error: abort
  - id: apply
    kind: actions
    inputs: [tag]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [tags]
---
## Notiz-Tagger

Generische, vault-agnostische Beispiel-Crew: findet Notizen **ohne** \`tags\` im
Ordner \`Notizen/\`, liest ihren Inhalt (\`include_content: true\`) und schlägt
2–4 thematische Tags vor (\`frontmatter.set\` mit \`allowed_keys: [tags]\`).

**Vor dem ersten Lauf anpassen:** Trage bei \`params.folder\` UND bei
\`write_scope\` deinen Zielordner ein (beide zeigen bewusst auf denselben Ordner,
damit nicht Notizen gesammelt werden, die außerhalb der Schreibfreigabe liegen).
\`write_scope\` steht absichtlich NICHT auf dem ganzen Vault (\`**/*.md\`), damit ein
frisch installiertes Team nicht versehentlich überall schreibt.
`;

export const REIFEGRAD_TAGGER_TEAM = `---
crew-kind: team
name: Reifegrad-Tagger
version: 1
description: Schätzt den Reifegrad von Notizen aus ihrem Inhalt und schreibt ihn ins Frontmatter.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "20_Zettel/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: 20_Zettel
      where_missing: [reifegrad]
      limit: 15
      fields: [reifegrad]
      include_content: true
  - id: classify
    kind: llm
    agent: reifegrad-tagger
    inputs: [collect]
    instruction: |
      Du bekommst Notizen samt Inhalt, die noch keinen Reifegrad haben. Ordne
      jeder GENAU einen Reifegrad zu: keim, wachsend oder reif. Nutze nur diese
      drei Werte. Bei zu wenig Inhalt: nichts zuordnen.
    output:
      family: frontmatter.set
      allowed_keys: [reifegrad]
    on_error: abort
  - id: apply
    kind: actions
    inputs: [classify]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [reifegrad]
---
## Reifegrad-Tagger

Pallas-Demo: schätzt für die Zettel in \`20_Zettel/\` einen Reifegrad
(\`keim\`/\`wachsend\`/\`reif\`) aus dem Inhalt und schreibt ihn ins Frontmatter
(\`frontmatter.set\` mit \`allowed_keys: [reifegrad]\`, \`include_content: true\`).

**Bewusste Limitation — Wertebeschränkung nur aus dem Prompt:** \`frontmatter.set\`
+ \`allowed_keys\` beschränkt, WELCHE Felder gesetzt werden, aber nicht die
erlaubten WERTE eines Feldes. Die strukturelle Enum-Erzwingung (Slug-Wertemenge)
greift erst, wenn \`reifegrad\` im Ordner bereits Ist-Werte hat. Beim allerersten
Lauf kommt die Beschränkung auf \`keim/wachsend/reif\` daher nur aus der Instruktion
und dem Agent-Prompt. „Erlaubte Werte pro Feld" ist bewusst noch kein Feature.
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
