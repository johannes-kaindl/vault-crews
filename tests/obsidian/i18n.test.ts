// registerI18n() ist der einzige Ort, der die EN/DE-Dicts bei der vendorten
// i18n-Engine (src/vendor/kit/i18n.ts) registriert. setLang() ist Modul-globaler
// Zustand — jeder Test setzt ihn explizit zurück, damit die Reihenfolge der Tests
// das Ergebnis nicht beeinflusst (pristine output).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang, t } from "../../src/vendor/kit/i18n";
import { DE, EN, registerI18n } from "../../src/i18n/strings";

beforeEach(() => {
  registerI18n();
  setLang("en");
});
afterEach(() => {
  setLang("en");
});

describe("registerI18n + t()", () => {
  it("returns the EN string for a known key by default", () => {
    expect(t("cmd.runCrew")).toBe("Run crew…");
  });

  it("setLang('de') switches t() to the DE translation", () => {
    setLang("de");
    expect(t("cmd.runCrew")).toBe("Crew ausführen…");
  });

  it("falls back to the key itself for a missing key", () => {
    expect(t("does.not.exist")).toBe("does.not.exist");
  });

  it("interpolates {0}/{1}/{2} positional args", () => {
    expect(t("cmd.runCrewNamed", "Daily briefing")).toBe("Run crew: Daily briefing");
    expect(t("panel.header.running", 2, 3, "analyse")).toBe("Task 2/3: analyse");
  });

  it("leaves unmatched placeholders untouched when an arg is missing", () => {
    expect(t("cmd.runCrewNamed")).toBe("Run crew: {0}");
  });
});

describe("EN/DE dictionaries", () => {
  it("define exactly the same set of keys (no drift between languages)", () => {
    expect(Object.keys(DE).sort()).toEqual(Object.keys(EN).sort());
  });

  it("are both non-empty and cover the core command keys", () => {
    for (const key of ["cmd.runCrew", "cmd.abortRun", "cmd.undoLastRun", "cmd.openPanel"]) {
      expect(EN[key]).toBeTruthy();
      expect(DE[key]).toBeTruthy();
    }
  });
});
