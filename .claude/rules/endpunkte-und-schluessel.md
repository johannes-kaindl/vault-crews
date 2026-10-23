---
paths:
  - "src/core/endpoint-settings.ts"
  - "src/core/model-resolution.ts"
  - "src/core/local-llm-client.ts"
  - "src/obsidian/settings.ts"
  - "src/main.ts"
  - "tests/core/endpoint-settings.test.ts"
  - "tests/core/redact.test.ts"
---

# Endpunkte und Schlüssel

Gotchas zu Endpunkt-Einträgen, Modellwahl und dem Zeilen-Editor aus dem Kit. Die Regeln zum Schlüsselbund und zur Schwärzung stehen im Kern der `AGENTS.md`.

- **Endpunkte tragen ihren Schlüssel und ihr Modell** (`EndpointConfig[]`, Kit `endpoint_config`): es gibt **kein globales Modellfeld** — ein Modellname existiert nur auf dem Endpunkt, der ihn in `/v1/models` meldet. Ein Agenten-`model:` gilt, solange der aktive Endpunkt es führt, sonst das Modell der Zeile (`resolveTaskModel`). Der Client nimmt den ganzen Eintrag (`setEndpoint(cfg)`), nie URL und Schlüssel getrennt: der Resolver liefert die **normalisierte** URL, der gespeicherte Eintrag bleibt roh, ein Vergleich über die URL greift also bei jedem `/v1`-Suffix daneben. Das gilt für die lokale Liste; ist das Plugin `llm-endpoint-manager` installiert, kommen Endpunkt, Schlüssel und Modell von dort (`VaultCrewsPlugin.effectiveEndpoints()` über Kit `endpoint-source`, Wahl im Feld `choice`), und ein Manager-Fehler ergibt eine leere Liste, keinen Rückfall auf lokal.

- **Kit-Zeilen-Editor, zwei Consumer-Pflichten:** `SettingsTab.hide()` MUSS `cache.clear()` rufen (sonst bleibt ein einmal als unerreichbar gemessener Endpunkt die ganze Sitzung so stehen), und `clientFor` braucht **ausgeschriebene Rückgabetypen** — die Options-Signatur ist eine Intersection zweier `probe()`-Formen, ein Objekt-Literal ohne Annotation erfüllt keine davon.
