---
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

Fasst die offenen Aufgaben aus `Aufgaben/` zu einem kurzen Briefing zusammen und schreibt es per `section.replace` in die heutige Tagesnotiz (`Tagesnotizen/{{today}}.md`, Dateiname im Format `YYYY-MM-DD`). Der Block steht zwischen den Markern `<!-- crew:daily-briefing -->` … `<!-- /crew:daily-briefing -->`. Dank `create_if_missing: true` wird die Tagesnotiz angelegt, falls sie noch nicht existiert (nur der Marker-Block, keine Vorlage). Ein Undo entfernt die so erzeugte Notiz wieder (Papierkorb).

**Vor dem ersten Lauf anpassen:** Trage bei `params.folder` den Ordner mit deinen Aufgaben-Notizen ein, bei `write_scope` und `target` den Ordner und das Datumsformat deiner Tagesnotizen (die Einstellung des Kern-Plugins „Tagesnotizen“ nennt beides).

**Bewusste Vereinfachung – ein Modellaufruf:** Diese Beispiel-Crew nutzt EINEN llm-Task (Agent `briefing-autor`) statt getrennter Analyst- und Autor-Rollen. Bei einem einzelnen kurzen Briefing pro Tag bringt der Zwischenschritt wenig, kostet aber einen weiteren Modellaufruf (und damit Zeit und Fehleroberfläche).

**Bewusste Vereinfachung – keine harten Datumsgrenzen:** Der Collector `tasknotes.query` kennt keinen Datums-Bereichsfilter – `where` vergleicht nur Werte aus einer Liste, kein `>` oder `<` auf Datumswerten. Zur Laufzeit wird außerdem nur das `target`-Feld eines `actions`-Tasks mit `{{today}}` expandiert; die `instruction` eines `llm`-Tasks ist statischer Text, dem Modell kann das aktuelle Datum also nicht zuverlässig mitgegeben werden. Statt eine nicht vorhandene Fähigkeit vorzutäuschen, holt `collect` alle offenen Aufgaben (Backlog + Aktiv) samt optionalem `frist`-Feld, und `briefing-autor` ordnet sie nach bestem Ermessen den drei Abschnitten zu. Wer harte Datumsgrenzen braucht, erweitert das Team nach der Installation um eigene Logik (z. B. einen `actions`-Vor-Task, der nach Datum vorfiltert).

**Schreiblimit:** `max_writes: 1` (genau die eine Tagesnotiz) – bewusst enger als das Plugin-Standardlimit von 10, weil dieses Team strukturell nie mehr als eine Datei schreibt.
