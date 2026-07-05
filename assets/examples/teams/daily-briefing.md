---
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
---
## Daily-Briefing

Fasst die offenen Aufgaben aus `10_Aufgaben/` zu einem kurzen Briefing
zusammen und schreibt es per `section.replace` in die heutige Daily Note
(`30_Chronos/10_Tage/{{today}}.md`, Format `YYYY-MM-DD` – Pallas-Vault-
Konvention aus `periodic-notes`/`daily-notes.json`). Der Block steht zwischen
den Markern `<!-- crew:daily-briefing -->` … `<!-- /crew:daily-briefing -->`;
existiert die Ziel-Datei nicht, schlägt der Task kontrolliert fehl (kein
`create_if_missing`, Spec §4.3) – lege die heutige Daily Note vorher an
(Periodic-Notes-Command oder von Hand).

**Bewusste Vereinfachung ggü. Spec §9 (Wortlaut „Analyst-JSON → Autor-
Markdown“):** Diese Beispiel-Crew nutzt EINEN llm-Task (Agent
`briefing-autor`) statt getrennter Analyst- und Autor-Rollen. Bei einem
einzelnen kurzen Briefing pro Tag bringt der Zwischenschritt wenig
zusätzlichen Nutzen, kostet aber einen weiteren Modellaufruf (und damit
Zeit + Fehleroberfläche).

**Bewusste Vereinfachung von „heute fällig + überfällig“ (wörtlich Spec
§9):** Der reale `tasknotes.query`-Collector (`src/core/collectors.ts`) kennt
keinen Datums-Bereichsfilter – `where` matcht nur Key→Slug-Werteliste, kein
`>`/`<` auf Datumswerten. Außerdem wird zur Laufzeit ausschließlich das
`target`-Feld eines `actions`-Tasks mit `{{today}}` expandiert; die
`instruction` eines `llm`-Tasks ist statischer Text ohne Datums-Platzhalter –
dem Modell kann das aktuelle Datum also nicht zuverlässig mitgegeben werden.
Statt eine nicht vorhandene Collector-Fähigkeit vorzutäuschen, holt `collect`
alle offenen Aufgaben (Backlog + Aktiv) samt optionalem `frist`-Feld, und
`briefing-autor` ordnet sie nach bestem Ermessen den drei Abschnitten zu
(siehe Instruktion oben). Wer harte Datumsgrenzen braucht, kann das Team nach
der Installation um eigene Logik erweitern (z. B. einen `actions`-Vor-Task,
der nach Datum vorfiltert).

**Abweichung von Spec-§2.3-Analogie `max_writes: 15`:** Hier `max_writes: 1`
(genau die eine Daily Note) – bewusst enger als das Plugin-Standardlimit von
10, weil dieses Team strukturell nie mehr als eine Datei schreibt.
