// Pure Logik des Endpoint-Zeilen-Editors (Ansatz A, UI-STANDARD §6): obsidian-/DOM-frei,
// hier ohne Mock getestet. Die dünne Render-Seite (settings.ts) bleibt ungetestet.
import { describe, expect, it } from "vitest";
import {
  applyEndpointEdit,
  activeIndexFromStatuses,
  modelFieldMode,
  statusKindKey,
  warnRuleKey,
} from "../../src/obsidian/endpoint-editor-model";

describe("applyEndpointEdit", () => {
  it("hängt am Adder einen neuen, getrimmten Eintrag an", () => {
    expect(applyEndpointEdit(["http://a:1"], 1, "  http://b:2 ", true)).toEqual([
      "http://a:1",
      "http://b:2",
    ]);
  });

  it("ignoriert einen leeren Adder-Wert (No-Op)", () => {
    expect(applyEndpointEdit(["http://a:1"], 1, "   ", true)).toEqual(["http://a:1"]);
  });

  it("editiert einen Eintrag an seiner Stelle", () => {
    expect(applyEndpointEdit(["http://a:1", "http://b:2"], 0, "http://x:9", false)).toEqual([
      "http://x:9",
      "http://b:2",
    ]);
  });

  it("entfernt einen Eintrag, dessen Wert geleert wird", () => {
    expect(applyEndpointEdit(["http://a:1", "http://b:2"], 0, "", false)).toEqual(["http://b:2"]);
  });

  it("filtert am Ende alle Leereinträge weg", () => {
    expect(applyEndpointEdit(["http://a:1", "   "], 0, "http://a:1", false)).toEqual(["http://a:1"]);
  });
});

describe("activeIndexFromStatuses", () => {
  it("liefert den Index der ersten ok-Zeile", () => {
    expect(activeIndexFromStatuses([null, "refused", "ok", "ok"])).toBe(2);
  });

  it("liefert 0, wenn die erste Zeile bereits ok ist", () => {
    expect(activeIndexFromStatuses(["ok", "ok"])).toBe(0);
  });

  it("liefert -1, wenn keine Zeile ok ist", () => {
    expect(activeIndexFromStatuses([null, "refused", "timeout"])).toBe(-1);
  });
});

describe("modelFieldMode", () => {
  it("freetext, wenn keine Modelle geladen sind", () => {
    expect(modelFieldMode([], "")).toBe("freetext");
    expect(modelFieldMode([], "gemma")).toBe("freetext");
  });

  it("dropdown bei geladenen Modellen und leerer Auswahl", () => {
    expect(modelFieldMode(["gemma", "qwen"], "")).toBe("dropdown");
  });

  it("dropdown, wenn das gespeicherte Modell in der Liste ist", () => {
    expect(modelFieldMode(["gemma", "qwen"], "qwen")).toBe("dropdown");
  });

  it("dropdown auch wenn das gespeicherte Modell NICHT in der Liste ist (der Wert wird als Option bewahrt, statt den Dropdown zu verstecken)", () => {
    expect(modelFieldMode(["gemma", "qwen"], "llama")).toBe("dropdown");
  });
});

describe("i18n-Key-Mapping", () => {
  it("statusKindKey bildet den Kind auf einen Settings-Key ab", () => {
    expect(statusKindKey("refused")).toBe("settings.endpoint.status.refused");
    expect(statusKindKey("not-an-llm-api")).toBe("settings.endpoint.status.not-an-llm-api");
  });

  it("warnRuleKey bildet die Regel auf einen Settings-Key ab", () => {
    expect(warnRuleKey("port")).toBe("settings.endpoint.warn.port");
  });
});
