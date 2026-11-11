/** Beispiel-Crews, deutsche Fassung: Inhalte als TS-String-Konstanten, weil esbuild keine
 *  .md/.base-Dateien bündelt — dies ist die Laufzeit-Quelle, die install-examples.ts
 *  in den Vault schreibt (Vault-Sprache Deutsch). Die englische Fassung steht in
 *  `example-assets-en.ts`. `assets/examples/de/**` ist der Klartext-Spiegel dieser
 *  Inhalte (byte-identisch, von tests/obsidian/install-examples.test.ts geprüft) —
 *  bei Änderungen BEIDE Stellen pflegen. Standardordner sind neutral (`Aufgaben`,
 *  `Tagesnotizen`, `Notizen`), jedes Team nennt im Text, dass der Nutzer sie anpasst.
 *  Absätze stehen auf einer Zeile (Obsidian bricht sonst mitten im Absatz um). */

export const TRIAGE_ANALYST_AGENT = `---
crew-kind: agent
name: Triage-Analyst
temperature: 0.1
max_tokens: 2048
thinking: off
---
Du bist ein nüchterner Task-Triage-Analyst für einen persönlichen Obsidian-Vault. Du bewertest Aufgaben-Notizen anhand ihres Frontmatters und schlägst NUR Metadaten-Korrekturen an weichen Feldern vor (priority, kontext, projekt, period). Du erfindest nichts, du löschst nichts, du änderst niemals title, status oder type. Bei Unsicherheit schlägst du NICHTS vor.
`;

export const BRIEFING_AUTOR_AGENT = `---
crew-kind: agent
name: Briefing-Autor
temperature: 0.2
max_tokens: 1536
thinking: off
---
Du bist der Autor eines kurzen, ruhigen Tages-Briefings für einen persönlichen Obsidian-Vault. Du bekommst eine Liste offener Aufgaben (Titel, Status, Priorität, Kontext, Projekt und – falls vorhanden – Fälligkeitsdatum) als JSON. Du schreibst daraus knappes Markdown mit GENAU drei Abschnitten: „Heute fällig“, „Überfällig“, „Eine nächste Handlung“. Du nutzt ausschließlich Titel aus dem Quellmaterial, du erfindest keine Aufgaben. Ist ein Abschnitt leer, schreibst du einen kurzen, beruhigenden Satz statt einer leeren Liste. „Eine nächste Handlung“ nennt genau EINE konkrete, sofort ausführbare Aufgabe – deine Wahl, keine Liste.
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
  - "Aufgaben/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Aufgaben
      where: { status: [backlog] }
      limit: 25
      fields: [title, status, priority, kontext, projekt, period]
  - id: analyse
    kind: llm
    agent: triage-analyst
    inputs: [collect]
    instruction: |
      Bewerte jede Aufgabe: fehlende priority? leerer kontext? fehlendes projekt oder period, obwohl thematisch naheliegend? Schlage pro Aufgabe höchstens eine Frontmatter-Korrektur vor. Bei Unsicherheit: nichts vorschlagen.
    output_schema: triage-v1
    on_error: abort
  - id: apply
    kind: actions
    inputs: [analyse]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [priority, kontext, projekt, period]
---
## Task-Triage

Prüft den Backlog im Ordner \`Aufgaben/\` und schlägt Korrekturen an **weichen** Feldern vor (priority, kontext, projekt, period) – niemals an status oder type (strukturell erzwungen über \`allowed_keys\` im \`apply\`-Task).

**Vor dem ersten Lauf anpassen:** Trage bei \`params.folder\` UND bei \`write_scope\` den Ordner mit deinen Aufgaben-Notizen ein (beide zeigen bewusst auf denselben Ordner), und passe Feld-Liste, Statuswert (\`backlog\`) und Instruktion an dein Schema an. Nach der Installation ist alles frei editierbar.

**Schreiblimit:** \`limits.max_writes\` steht auf 10, weil das Plugin-Standardlimit (Einstellungen → Sicherheit → „Max. Schreibvorgänge pro Lauf“) ebenfalls bei 10 liegt und jeden Wert nach oben deckelt. Ein frisch installiertes Team soll nicht schon an der eigenen Preflight-Validierung scheitern. Wer mehr braucht, hebt zuerst das Plugin-Limit an und danach dieses Feld.
`;

export const DAILY_BRIEFING_TEAM = `---
crew-kind: team
name: Daily-Briefing
version: 1
description: Fasst offene Aufgaben zu einem kurzen Tages-Briefing zusammen und schreibt es in die heutige Tagesnotiz.
trigger: manual
limits:
  max_writes: 1
write_scope:
  - "Tagesnotizen/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Aufgaben
      where: { status: [backlog, aktiv] }
      sort: priority
      limit: 30
      fields: [title, status, priority, kontext, projekt, frist]
  - id: briefing
    kind: llm
    agent: briefing-autor
    inputs: [collect]
    instruction: |
      Du bekommst offene Aufgaben (Backlog + Aktiv, keine erledigten) mit Titel, Status, Priorität, Kontext, Projekt und – falls vorhanden – Fälligkeitsdatum (frist). Schreibe ein kurzes Tages-Briefing in Markdown mit GENAU diesen drei Abschnitten:

      ## Heute fällig
      ## Überfällig
      ## Eine nächste Handlung

      Ordne jede Aufgabe nach bestem Ermessen zu: ein frist-Datum in der Vergangenheit gehört zu „Überfällig"; eine Aufgabe ohne frist, aber mit Status „aktiv", gehört zu „Heute fällig". Ist ein Abschnitt leer, schreibe einen kurzen, beruhigenden Satz statt einer leeren Liste. „Eine nächste Handlung" nennt genau EINE konkrete, sofort ausführbare Aufgabe aus der Liste.
    output_schema: briefing-v1
    on_error: abort
  - id: apply
    kind: actions
    inputs: [briefing]
    allowed_actions: [section.replace]
    target: "Tagesnotizen/{{today}}.md"
    create_if_missing: true
---
## Daily-Briefing

Fasst die offenen Aufgaben aus \`Aufgaben/\` zu einem kurzen Briefing zusammen und schreibt es per \`section.replace\` in die heutige Tagesnotiz (\`Tagesnotizen/{{today}}.md\`, Dateiname im Format \`YYYY-MM-DD\`). Der Block steht zwischen den Markern \`<!-- crew:daily-briefing -->\` … \`<!-- /crew:daily-briefing -->\`. Dank \`create_if_missing: true\` wird die Tagesnotiz angelegt, falls sie noch nicht existiert (nur der Marker-Block, keine Vorlage). Ein Undo entfernt die so erzeugte Notiz wieder (Papierkorb).

**Vor dem ersten Lauf anpassen:** Trage bei \`params.folder\` den Ordner mit deinen Aufgaben-Notizen ein, bei \`write_scope\` und \`target\` den Ordner und das Datumsformat deiner Tagesnotizen (die Einstellung des Kern-Plugins „Tagesnotizen“ nennt beides).

**Bewusste Vereinfachung – ein Modellaufruf:** Diese Beispiel-Crew nutzt EINEN llm-Task (Agent \`briefing-autor\`) statt getrennter Analyst- und Autor-Rollen. Bei einem einzelnen kurzen Briefing pro Tag bringt der Zwischenschritt wenig, kostet aber einen weiteren Modellaufruf (und damit Zeit und Fehleroberfläche).

**Bewusste Vereinfachung – keine harten Datumsgrenzen:** Der Collector \`tasknotes.query\` kennt keinen Datums-Bereichsfilter – \`where\` vergleicht nur Werte aus einer Liste, kein \`>\` oder \`<\` auf Datumswerten. Zur Laufzeit wird außerdem nur das \`target\`-Feld eines \`actions\`-Tasks mit \`{{today}}\` expandiert; die \`instruction\` eines \`llm\`-Tasks ist statischer Text, dem Modell kann das aktuelle Datum also nicht zuverlässig mitgegeben werden. Statt eine nicht vorhandene Fähigkeit vorzutäuschen, holt \`collect\` alle offenen Aufgaben (Backlog + Aktiv) samt optionalem \`frist\`-Feld, und \`briefing-autor\` ordnet sie nach bestem Ermessen den drei Abschnitten zu. Wer harte Datumsgrenzen braucht, erweitert das Team nach der Installation um eigene Logik (z. B. einen \`actions\`-Vor-Task, der nach Datum vorfiltert).

**Schreiblimit:** \`max_writes: 1\` (genau die eine Tagesnotiz) – bewusst enger als das Plugin-Standardlimit von 10, weil dieses Team strukturell nie mehr als eine Datei schreibt.
`;

export const NOTIZ_TAGGER_AGENT = `---
crew-kind: agent
name: Notiz-Tagger
temperature: 0.2
max_tokens: 1024
thinking: off
---
Du bist ein nüchterner Verschlagworter für einen persönlichen Obsidian-Vault. Du bekommst den Inhalt einzelner Notizen und schlägst pro Notiz 2–4 knappe, thematische Tags vor: kleingeschrieben, ohne #, je ein Wort oder ein kurzer bindestrich-getrennter Begriff, und lieferst sie als Liste. Du orientierst dich ausschließlich am Notiz-Inhalt und erfindest keine Themen. Bei einer inhaltsarmen Notiz schlägst du weniger oder gar keine Tags vor.
`;

export const REIFEGRAD_TAGGER_AGENT = `---
crew-kind: agent
name: Reifegrad-Tagger
temperature: 0.1
max_tokens: 1024
thinking: off
---
Du bist ein nüchterner Reifegrad-Einschätzer für die Notizen eines persönlichen Obsidian-Vaults. Du bekommst den Inhalt einzelner Notizen und ordnest jeder GENAU einen Reifegrad zu: „keim“ (loser Gedanke, Stichworte), „wachsend“ (in Arbeit, teilausgeführt) oder „reif“ (ausgearbeitet, in sich geschlossen). Du nutzt ausschließlich diese drei Werte und stützt dich nur auf den vorliegenden Inhalt. Bei zu wenig Inhalt für eine Einschätzung ordnest du nichts zu.
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
      Du bekommst Notizen samt Inhalt, die noch keine Tags haben. Schlage pro Notiz 2–4 knappe, thematische Tags **als Liste** vor, abgeleitet ausschließlich aus dem Inhalt. Erfinde keine Themen; bei inhaltsarmen Notizen weniger oder keine.
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

Generische, vault-agnostische Beispiel-Crew: findet Notizen **ohne** \`tags\` im Ordner \`Notizen/\`, liest ihren Inhalt (\`include_content: true\`) und schlägt 2–4 thematische Tags vor (\`frontmatter.set\` mit \`allowed_keys: [tags]\`).

**Vor dem ersten Lauf anpassen:** Trage bei \`params.folder\` UND bei \`write_scope\` deinen Zielordner ein (beide zeigen bewusst auf denselben Ordner, damit nicht Notizen gesammelt werden, die außerhalb der Schreibfreigabe liegen). \`write_scope\` steht absichtlich NICHT auf dem ganzen Vault (\`**/*.md\`), damit ein frisch installiertes Team nicht versehentlich überall schreibt.
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
  - "Notizen/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Notizen
      where_missing: [reifegrad]
      limit: 15
      fields: [reifegrad]
      include_content: true
  - id: classify
    kind: llm
    agent: reifegrad-tagger
    inputs: [collect]
    instruction: |
      Du bekommst Notizen samt Inhalt, die noch keinen Reifegrad haben. Ordne jeder GENAU einen Reifegrad zu: keim, wachsend oder reif. Nutze nur diese drei Werte. Bei zu wenig Inhalt: nichts zuordnen.
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

Schätzt für die Notizen im Ordner \`Notizen/\` einen Reifegrad (\`keim\`/\`wachsend\`/\`reif\`) aus dem Inhalt und schreibt ihn ins Frontmatter (\`frontmatter.set\` mit \`allowed_keys: [reifegrad]\`, \`include_content: true\`).

**Vor dem ersten Lauf anpassen:** Trage bei \`params.folder\` UND bei \`write_scope\` deinen Zielordner ein (beide zeigen bewusst auf denselben Ordner). Feldname und Werte (\`reifegrad\`, \`keim\`/\`wachsend\`/\`reif\`) sind ein Vorschlag, passe sie an dein Schema an.

**Bewusste Limitation – Wertebeschränkung nur aus dem Prompt:** \`frontmatter.set\` + \`allowed_keys\` beschränkt, WELCHE Felder gesetzt werden, aber nicht die erlaubten WERTE eines Feldes. Die strukturelle Enum-Erzwingung (Slug-Wertemenge) greift erst, wenn \`reifegrad\` im Ordner bereits Ist-Werte hat. Beim allerersten Lauf kommt die Beschränkung auf \`keim\`/\`wachsend\`/\`reif\` daher nur aus der Instruktion und dem Agent-Prompt. „Erlaubte Werte pro Feld“ ist bewusst noch kein Feature.
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
    displayName: Schreibvorgänge
  llm_calls:
    displayName: Modellaufrufe
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
