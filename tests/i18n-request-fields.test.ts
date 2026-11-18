// Vollstaendigkeits-Waechter fuer die Zeilen des Abschnitts „Anfrage“ (CORE-TEST-04, dritter Anwendungsfall).
//
// Das Plugin fuehrt die Feldnamen des Kit-Abschnitts ueber eigene Woerterbuchzeilen (`request.field.<feld>`, settings.ts `fieldName`);
// `t()` faellt bei fehlendem Schluessel auf den SCHLUESSEL zurueck. Kommt im Kit ein Feld dazu (obsidian-kit 0.97.0: `seed`), stuende
// in der Zeile sonst `request.field.seed`, und kein Typ bricht. Der Test haengt an `FIELD_ORDER` des gevendorten Kits.
import { describe, expect, it } from "vitest";
import { DE, EN } from "../src/i18n/strings";
import { FIELD_ORDER } from "../src/vendor/kit/sampling-profiles";

describe("Woerterbuch: ein Name je Feld des Abschnitts „Anfrage“", () => {
  for (const [lang, dict] of [["en", EN], ["de", DE]] as const) {
    it(`${lang}: jedes Feld aus FIELD_ORDER hat request.field.<feld>`, () => {
      const missing = FIELD_ORDER.filter((f) => typeof dict[`request.field.${f}`] !== "string" || dict[`request.field.${f}`] === "");
      expect(missing).toEqual([]);
    });
  }
  it("der Name nennt das Feld in Klammern wie bei den anderen (Kit: „Random seed (seed)“)", () => {
    for (const f of FIELD_ORDER) {
      expect(EN[`request.field.${f}`], f).toContain(`(${f})`);
      expect(DE[`request.field.${f}`], f).toContain(`(${f})`);
    }
  });
});
