# Design: Provider-agnostische lokale LLM-Anbindung (Ollama-Support)

**Datum:** 2026-07-07
**Status:** Design (vor Implementierungsplan)
**Betrifft:** `src/core/lmstudio-client.ts`, `src/core/ports.ts`, `src/core/orchestrator.ts`, `src/obsidian/transports.ts`, `src/core/run-log.ts`, `src/main.ts`, neu `src/core/model-info.ts`

## Problem

vault-crews ist heute faktisch auf LM Studio zugeschnitten, obwohl der Endpoint frei
konfigurierbar ist (Settings → „Endpoints", Failover-Liste) und der Client bereits
OpenAI-kompatibel spricht (`/v1/chat/completions`, `/v1/models`). Zwei Stellen sind
LM-Studio-spezifisch und laufen bei Ollama ins Leere:

1. **Kontextlängen-Erkennung** (`modelInfo`) fragt LM Studios proprietäres
   `/api/v0/models` ab. Ollama kennt das nicht → `contextLength: null` → keine
   Overflow-Vorwarnung.
2. **Thinking-Suppression** sendet `reasoning_effort:"none"` +
   `chat_template_kwargs.enable_thinking:false`. Ollama braucht v.a. das erste, lehnt
   aber Boolean/`"minimal"` für `reasoning_effort` ab (dokumentierter Gotcha).

Zusätzlich blockt Ollama Streaming-Requests aus Obsidian per Default (CORS, kein
`OLLAMA_ORIGINS`) → der Ping gelingt, der Stream failt hart.

## Nicht-Ziel

- **Kein Provider-Enum, kein Provider-Dropdown, kein neues Setting.** Die Nachbar-Plugins
  (`markdown-presentation`, `vault-rag`, `image-to-markdown`) lösen exakt dieselbe Aufgabe
  ohne Provider-Begriff: der Client sondiert beide nativen Metadaten-Endpunkte und nimmt,
  was antwortet. Das übernehmen wir (Kit-first, AGENTS.md).
- **Keine Cloud-Endpunkte.** vault-crews bleibt im „nur lokale Modelle"-Positioning; die
  bestehende Denylist (`:8080`) bleibt unberührt.
- **Kein Datenmodell-Umbau.** Endpoints bleiben freie URLs; Failover via
  `parseEndpointList`/`resolveActiveEndpoint` (Kit, bereits vendored) unverändert.

## Ansatz

Der Client wird **provider-agnostisch**: er weiß nicht, welcher Server dahintersteht, er
probiert. Referenzmuster: `markdown-presentation/src/llm-client.ts` +
`src/core/llm/model-info.ts` + `reasoning.ts`.

### 1. Neuer pure-Layer `src/core/model-info.ts`

Obsidian-frei (CI-Gate `check:pure`). Portiert aus `markdown-presentation`:

- `parseLmStudioContext(json, model)` — aus der heutigen `modelInfo` extrahiert;
  `loaded_context_length ?? max_context_length`.
- `parseOllamaContext(json)` — liest `model_info["<arch>.context_length"]` aus der
  `/api/show`-Antwort.
- `suppressParams(suppress: boolean)` — Union-Objekt: `reasoning_effort:"none"` +
  `chat_template_kwargs.enable_thinking:false` + `reasoning_budget:0`. Leeres Objekt, wenn
  nicht unterdrückt wird.
- `isAlwaysOnThinker(model)` — erkennt Modelle mit fest verdrahtetem Reasoning
  (`/\b(gpt-oss|harmony)\b/i`), die sich per `reasoning_effort:"none"` nicht abschalten
  lassen.

### 2. Client: `LmStudioClient` → `LocalLlmClient` (Rename)

`lmstudio-client.ts` → `local-llm-client.ts`, Klasse `LmStudioClient` → `LocalLlmClient`.
Reiner Rename (Verhalten unverändert), berührt `main.ts` + Tests. Motivation: der Name
ist nach dem Umbau sonst irreführend.

Inhaltliche Änderungen an der Klasse:

- **`modelInfo(model)` — Doppel-Sonde:** erst `GET /api/v0/models` → `parseLmStudioContext`;
  kein Treffer → `POST /api/show` mit `{ model }` (via `JsonTransport.postJson`, existiert
  bereits) → `parseOllamaContext`. Beides best-effort in `try/catch`; sonst `null` wie heute.
- **Thinking-Suppression** ersetzt die inline-Zweige durch `suppressParams(params.thinking === 'off')`
  (bringt `reasoning_budget:0` mit).

### 3. CORS-Non-Stream-Fallback

- **Transport-Feinschliff** (`XhrSseTransport`): `xhr.onerror` setzt `e.name = "StreamNetworkError"`
  auf dem Reject-Error (statt generischer Message). Damit hat der Client einen sauberen
  Vertrag, um CORS-/Netzwerk-Refusal von `AbortError` und von HTTP-Fehlern (die weiterhin
  *resolven*, nicht rejecten) zu unterscheiden.
- **`LocalLlmClient.stream()`** fängt einen Reject mit `name === "StreamNetworkError"`,
  merkt sich `streamRefused = true` (Instanz-Feld, spätere Calls im selben Lauf skippen
  Streaming direkt → begrenzt das Run-Budget) und fällt auf einen Non-Streaming-Call
  zurück: `JsonTransport.postJson(`${base}/v1/chat/completions`, { …, stream:false })`,
  dann `choices[0].message.content` extrahieren. `AbortError` propagiert unverändert.
- **Overflow im Fallback:** aus dem Antwort-Body-Text per Regex
  (`/context (length|window)|too many tokens/i`), genau wie der Streaming-Pfad heute —
  der HTTP-Status wird dafür nicht gebraucht (`postJson` gibt nur den Body zurück; keine
  Port-Änderung nötig).
- **Kosten:** kein Live-Token-Ticker im Panel für diesen Lauf; `finishReason` aus dem
  Non-Streaming-Body. Das ist der akzeptierte Trade-off gegenüber hartem Fail.

### 4. Always-on-Thinker-Surfacing

Im Orchestrator (`checkEndpointAndModel`, dort ist das Modell bekannt, ~`orchestrator.ts:150`):
wenn `thinking === 'off'` **und** `isAlwaysOnThinker(model)`, wird ein Flag auf dem
Run-State gesetzt. Daraus:

- **run.md-Vermerk** (`run-log.ts`): eine Zeile „Modell `<id>` denkt prinzipbedingt weiter
  (gpt-oss/harmony) — `thinking:off` greift nicht vollständig."
- **Einmalige Notice** (`main.ts`) beim Laufstart mit derselben Aussage.

Rein informativ; ändert Ablauf/Writes nicht.

## Datenfluss (unverändert bis auf Sonde)

```
Settings.endpoints (freie URLs)
  → parseEndpointList → resolveActiveEndpoint (ping)   [unverändert, Kit]
  → LocalLlmClient.setBase(aktiver Endpoint)           [unverändert]
  → modelInfo: /api/v0/models  ODER  /api/show         [NEU: Doppel-Sonde]
  → stream: /v1/chat/completions (SSE)                 [unverändert]
      └─ StreamNetworkError → postJson stream:false     [NEU: CORS-Fallback]
```

## Fehlerbehandlung

- `LlmCallError`-Kinds (`overflow|timeout|stalled|http`) bleiben; der Fallback wirft
  dieselben Kinds, sodass der Orchestrator seine Fehlerpfade unverändert nutzt.
- `modelInfo`-Doppel-Sonde schluckt beide Fehler → `null` (heutiges Verhalten, keine
  Regression).

## Testing

- **Pure-Parser** (`model-info.test.ts`): LM-Studio- + Ollama-Fixtures für
  `parseLmStudioContext`/`parseOllamaContext`; `suppressParams`-Union-Snapshot;
  `isAlwaysOnThinker` (gpt-oss ja, generisches Modell nein).
- **Client** (`local-llm-client.test.ts`): Doppel-Sonde (LM-Studio-Treffer bricht früh ab;
  Ollama-Fallback greift; keiner → null); Stream-Refusal → Non-Streaming-Fallback liefert
  Content; `AbortError` propagiert; Overflow-Sniff im Fallback.
- **Orchestrator**: Always-on-Flag wird gesetzt/geloggt bei `thinking:off` + gpt-oss.
- `npm run gate` (lint + typecheck + test + check:pure) grün.

## Offene Punkte

Keine. Smoke-Test-Ergänzung (Lauf gegen laufendes Ollama) wird im Implementierungsplan
als abschließender manueller Schritt aufgenommen.
