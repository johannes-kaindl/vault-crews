// Vollstaendigkeits-Waechter fuer die Endpunkt-Statusklassen (CORE-TEST-04).
//
// Warum es diesen Test braucht: die Statusklassen kommen aus dem vendorten Kit
// (`endpoint_diagnostics.ts`), die Saetze dazu fuehrt dieses Repo selbst ueber `t()`.
// Faellt dabei ein Schluessel aus, ist das UNSICHTBAR — `t()` faellt bei unbekanntem
// Schluessel auf den SCHLUESSEL zurueck, nicht auf EN. In der Oberflaeche stuende dann
// `settings.endpoint.status.unauthorized` und saehe aus wie ein plausibler String.
//
// Referenz-Implementierung: obsidian-transmute/tests/i18n-status-keys.test.ts.
import { describe, expect, it } from "vitest";
import { DE, EN } from "../src/i18n/strings";
import { statusKindKey } from "../src/obsidian/endpoint-labels";
import type { EndpointStatusKind } from "../src/vendor/kit/endpoint_diagnostics";

const DICTS: Record<"en" | "de", Record<string, string>> = { en: EN, de: DE };

// Der Kanarienvogel: bringt ein Kit-Update eine weitere Statusklasse mit (0.24.0 brachte
// `unauthorized`), bricht dieser Record am `typecheck:test` — also bevor der rohe
// Schluessel in der Oberflaeche landen kann.
const ALL_KINDS: Record<EndpointStatusKind, true> = {
  "ok": true,
  "refused": true,
  "unknown-host": true,
  "timeout": true,
  "not-an-llm-api": true,
  "unauthorized": true,
  "unknown": true,
};

describe("i18n-Abdeckung der Kit-Statusklassen", () => {
  it.each(Object.keys(ALL_KINDS) as EndpointStatusKind[])(
    "hat EN und DE fuer den Endpunkt-Status %s",
    (kind) => {
      const key = statusKindKey(kind);
      expect(DICTS.en[key], `EN fehlt: ${key}`).toBeTruthy();
      expect(DICTS.de[key], `DE fehlt: ${key}`).toBeTruthy();
    },
  );
});
