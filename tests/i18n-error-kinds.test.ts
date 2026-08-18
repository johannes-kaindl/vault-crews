// Vollstaendigkeits-Waechter fuer die Fehlerklassen (CORE-TEST-04, zweiter Anwendungsfall).
//
// Warum es diesen Test braucht: `ErrorKind` ist ein Core-Typ, die Saetze dazu fuehrt die
// Obsidian-Schicht ueber `t("notice.errorKind." + kind)` (main.ts, panel-view-model.ts).
// Faellt dabei ein Schluessel aus, ist das UNSICHTBAR — `t()` faellt bei unbekanntem
// Schluessel auf den SCHLUESSEL zurueck, nicht auf EN. In der Fehlerkarte stuende dann
// `notice.errorKind.output_truncated` und saehe aus wie ein plausibler String.
//
// Schwester-Waechter: tests/i18n-status-keys.test.ts (Kit-Statusklassen).
import { describe, expect, it } from "vitest";
import { DE, EN } from "../src/i18n/strings";
import { ERROR_KINDS } from "../src/core/run-log";
import type { ErrorKind } from "../src/core/types";

const DICTS: Record<"en" | "de", Record<string, string>> = { en: EN, de: DE };

// Der Kanarienvogel: kommt eine weitere Fehlerklasse dazu, bricht dieser Record am
// `typecheck:test` — also bevor der rohe Schluessel in der Oberflaeche landen kann.
const ALL_KINDS: Record<ErrorKind, true> = {
  "endpoint_unreachable": true,
  "endpoint_error": true,
  "model_missing": true,
  "timeout": true,
  "stalled": true,
  "invalid_output": true,
  "output_truncated": true,
  "context_overflow": true,
  "crew_invalid": true,
  "write_limit": true,
  "consistency": true,
  "aborted": true,
  "io": true,
};

describe("i18n-Abdeckung der Fehlerklassen", () => {
  it.each(Object.keys(ALL_KINDS) as ErrorKind[])(
    "hat EN und DE fuer die Fehlerklasse %s",
    (kind) => {
      const key = `notice.errorKind.${kind}`;
      expect(DICTS.en[key], `EN fehlt: ${key}`).toBeTruthy();
      expect(DICTS.de[key], `DE fehlt: ${key}`).toBeTruthy();
    },
  );

  // Zweite Drift-Naht: run.md liest ERROR_KINDS, die Oberflaeche den Typ. Laufen die
  // auseinander, faellt ein Kind aus dem Log-Vokabular, ohne dass irgendwo etwas bricht.
  it("ERROR_KINDS (run-log) deckt sich exakt mit dem Typ", () => {
    expect([...ERROR_KINDS].sort()).toEqual(Object.keys(ALL_KINDS).sort());
  });
});
