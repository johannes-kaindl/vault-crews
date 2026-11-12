// Vollständigkeits-Wächter für die Denkstufen (CORE-TEST-04, wie i18n-error-kinds).
//
// `ThinkingLevel` hat seit code-kit 0.65.0 sieben Werte (sechs seit 0.39.0, `minimal` ist die Stufe von gpt-oss statt `off`) (`off, minimal, low … high, xhigh, max`). Der Anfrage-Abschnitt aus dem Kit zeichnet
// jede Stufe über `t("request.level." + stufe)`; fällt ein Schlüssel aus, steht der rohe Schlüssel im Dropdown
// (`t()` fällt auf den Schlüssel zurück), und das sieht aus wie ein plausibler Text.
import { describe, expect, it } from "vitest";
import { DE, EN } from "../src/i18n/strings";
import { THINKING_LEVELS } from "../src/vendor/kit/sampling-profiles";

const DICTS: Record<"en" | "de", Record<string, string>> = { en: EN, de: DE };

describe("Denkstufen-Texte", () => {
  it("die Kit-Liste hat sieben Stufen (der Wächter misst die Liste, nicht seine eigene Annahme)", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  for (const lang of ["en", "de"] as const) {
    it(`${lang}: jede Stufe hat einen eigenen, nicht leeren Text`, () => {
      const dict = DICTS[lang];
      for (const stufe of THINKING_LEVELS) {
        const text = dict[`request.level.${stufe}`];
        expect(text, `request.level.${stufe} (${lang})`).toBeTruthy();
        expect(text).not.toBe(`request.level.${stufe}`);
      }
      const texte = THINKING_LEVELS.map((s) => dict[`request.level.${s}`]);
      expect(new Set(texte).size).toBe(THINKING_LEVELS.length);
    });
  }
});
