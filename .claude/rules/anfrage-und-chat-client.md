---
paths:
  - "src/core/crew-request.ts"
  - "src/core/local-llm-client.ts"
  - "src/core/model-info.ts"
  - "src/core/model-resolution.ts"
  - "src/core/orchestrator.ts"
  - "src/vendor/kit/chat-client.ts"
  - "src/obsidian/request-port.ts"
  - "src/obsidian/request-text.ts"
  - "src/obsidian/transports.ts"
  - "tests/core/crew-request.test.ts"
  - "tests/core/local-llm-client.test.ts"
---

# Modellaufruf — Anfrage, Chat-Client, Streaming

Gotchas zu dem, was ein Modellaufruf sendet und wie die Antwort ankommt.

- **Was ein Modellaufruf sendet, baut genau eine Funktion: `buildCrewParams` (`src/core/crew-request.ts`, Welle 14, 2026-09-30).** Modus fest `structured` (Ablauf steht vorher fest, das Modell füllt schema-validierte Verträge), drei Ebenen von oben nach unten: Persona-Frontmatter (`temperature`, `max_tokens`, `thinking`) > Plugin-Überschreibung je Modus × Modellfamilie (`settings.request`, Abschnitt „Anfrage") > Profil-Tabelle des Kits. `thinking: auto` heißt die Stufe des Plugins, Default off; `on` heißt fest `medium` (nicht `onLevelFor`, das für `structured` `low` liefert); `off` heißt off. `AgentDef.temperature` ist optional — ohne Persona-Wert gilt der Profilwert, es gibt keinen Parser-Default mehr. `LlmParams` ist `{ model, sentModel, params, thinkingLevel }` und trägt fertige Werte; `LocalLlmClient` sendet `params` unverändert und erfindet nichts. Familie und Backend kennt der pure Orchestrator nicht: er fragt nach `checkEndpointAndModel` den injizierten `RequestPort` (`RunDeps.request`, Obsidian-Seite in `src/obsidian/request-port.ts`), weil er den Endpunkt per Failover selbst wählt. Die Persona-Werte fließen VOR dem Port in `buildCrewParams` ein; die Kontextrechnung nimmt das tatsächlich gesendete `max_tokens`. Jede Anfrage geht in die Sitzung (`requestSession`), jede Antwort durch `checkResponse`. Die goldenen Requests (`tests/core/crew-request.test.ts`) laufen gegen `buildCrewParams`, nicht gegen die Kit-Funktion; der gpt-oss-Wächter („nie `none`") steht dort als Zeile. GUI-Smoke N2 misst den Body am Draht gegen einen Fake-Endpunkt, N1 bedient den Abschnitt; der Smoke wartet nach dem Schreiben einer Persona, bis der metadataCache sie trägt (sonst rechnet der Lauf mit der vorigen).

- **Der Chat-Client ist seit Welle 11 der Kit-Client (`createChatClient`, `src/vendor/kit/chat-client.ts`), `LocalLlmClient` bleibt die Fassade.** Der Kit-Client liegt in `src/vendor/kit/`, weil er kein `obsidian` importiert; die Transporte (`xhrSseTransport`, `requestUrlTransport`, `src/vendor/kit-obsidian/chat-transport.ts`) werden in `main.ts` injiziert. Das Kit kennt keinen harten Gesamt-Timer: `LocalLlmClient.stream` baut ihn über ein eigenes Signal nach (`budgetFired`), der Kit-Client trägt nur die Stille-Frist (`stallTimeoutS`) und bis zum ersten Chunk die Gesamtfrist. Kit-`timeout` wird vor dem ersten Chunk zu `LlmCallError('timeout')`, danach zu `'stalled'`. Der Fallback ohne Stream gilt je Kit-Client-Instanz, `setEndpoint` baut sie neu. ⚠️ Bis Welle 11 kamen `timeout`/`stalled` in Produktion nie an: der XHR-Transport lehnt bei Abbruch ab, der alte Client warf den AbortError vor dem `abortKind`-Zweig, `error_kind` wurde `io`; die Unit-Tests sahen es nicht, weil ihre Attrappe bei Abbruch auflöste statt abzulehnen — `FakeSse` lehnt jetzt wie der echte Transport ab, und der GUI-Smoke misst beide Fälle gegen einen Fake-Server (`w11ChatClient`).

- **`finishReason` ist ein echter Wert, kein Platzhalter (seit 2026-08-18).** Der Streaming-Pfad gab lange hart `'stop'` zurück, obwohl `LlmStreamResult` seit jeher `'length'` kennt — der Zweig war tot, weil die vendorte `sse.ts` auf Kit 0.2.0 stand und `finish_reason` verwarf. Beides ist behoben (Kopie auf 0.3.0, beide Client-Pfade lesen den Wert). Folge für den Orchestrator: **abgeschnitten ist nicht automatisch kaputt** — `'length'` wird erst zum Fehler (`output_truncated`), wenn die Validierung zusätzlich fehlschlägt; dann aber ohne Repair-Runde, weil die dieselbe Grenze träfe. Gemessen an LM Studio: `finish_reason` steht im letzten Chunk, dessen `delta` leer ist.

- **Schwärzung und Wiederherstellung kommen vom Kit-Chat-Client, `restoreContent` setzt der Orchestrator je Schema** (`LlmParams.restoreContent`: `json` für JSON-Schemata, `text` für Markdown wie `briefing-v1`, Default `json`). Fest `json` würde ein PEM in Markdown-Notizen doppelt maskiert zurückschreiben. Notizen gehen als JSON-Text in den Prompt, das „Original“ eines PEM trägt dort `\n` statt Zeilenumbrüchen.

- **LM Studio / Ollama:** Kontextlänge aus `/api/v0/models` (LM Studio) oder `POST /api/show` (Ollama, unter `model_info["<arch>.context_length"]`); die Denkstufe und die Sampling-Felder kommen seit Welle 14 aus der Profil-Tabelle (`buildCrewParams`, erster Punkt oben); bei Ollama ggf. `OLLAMA_ORIGINS` für Streaming, sonst greift der Non-Stream-Fallback; Stall-Timeout erst NACH dem ersten Chunk (JIT-TTFB).

- **Live-Token-Streaming braucht CORS am LLM-Server** (gemessen 2026-08-17 bei der README-Bebilderung): Der Ticker läuft als `XMLHttpRequest` aus dem Renderer und sendet zwingend `Origin: app://obsidian.md`. Ohne CORS lehnt LM Studio schon den Preflight ab (`OPTIONS` → 400), das Plugin fällt still auf den Non-Streaming-Pfad über `requestUrl` zurück (Hauptprozess, sendet keinen Origin) — der Lauf gelingt, das Panel zeigt bis zum Ende „Warte auf Ausgabe …". Für Ollama war das als `OLLAMA_ORIGINS` schon notiert; es gilt für **jeden** Anbieter. `lms server start --cors` schaltet es ein.
