// Übernommen aus obsidian-kit@0.92.0, tests/filename-sanitizer-source.types.test.ts (Wächter zum Freeze der Sanitizer-API v1, MIGRATION § 0.89.0 Paket B4b).
// Einzige Abweichung von der Quelle: die Importpfade auf die gevendorten Module; der Alias `FilenameSanitizerApiError` des Kit-Index (`src/pure`) entfällt,
// weil vault-crews den Index nicht vendort (dort `type FilenameSanitizerApiError = ApiError`, die Zeile `viaIndex` prüft hier nur noch `ApiError`).
import { describe, it, expect } from "vitest";
import type { FilenameHit } from "../src/vendor/kit/filename-policy";
import type { ApiError, FilenameSanitizerApi, NameCheck, SanitizeResult } from "../src/vendor/kit/filename-sanitizer-source";

/** Typ-Test zum Freeze der Sanitizer-API v1 (2026-11-14, Entscheidung Johannes; Kopf von `src/pure/filename-sanitizer-source.ts`). Geprüft wird beim Übersetzen, nicht beim Lauf:
 *  `npm run typecheck` bricht, sobald eine Änderung nicht additiv ist.
 *  (a) Je Typ ein Objekt mit GENAU den heutigen Pflichtfeldern muss zuweisbar sein: ein neues PFLICHTfeld bricht das (ein neues optionales Feld nicht).
 *  (b) Je Feld eine Zuweisung in die Gegenrichtung, vom Typ in den einfachen Typ: ein entferntes, umbenanntes oder umgetyptes Feld bricht das.
 *  Der Laufteil ist eine Kontrolle, dass die Beispiele wirklich gebaut werden (ein Test ohne Lauf bliebe ungesehen). */

const hit: FilenameHit = { rule: "edge", index: 0, length: 1, replacement: "" };

// ── (a) Objekte mit genau den heutigen Pflichtfeldern ──
const sanitizeResult: SanitizeResult = { name: "a.md", changed: false, hits: [] };
const nameCheck: NameCheck = { valid: true, hits: [hit] };
const apiError: ApiError = { error: "invalid-input", message: "m" };
const apiError2: ApiError = { error: "not-ready", message: "m" };   // beide heutigen Werte müssen bleiben (ein entfernter Wert bricht das)
const viaIndex: ApiError = apiError;
const api: FilenameSanitizerApi = {
  version: 1,
  sanitizeName: (name, opts) => ({ name: `${name}${opts.caller}`, changed: true, hits: [] }),
  checkName: () => ({ valid: true, hits: [] }),
};

// ── (b) je Feld die Gegenrichtung ──
const sName: string = sanitizeResult.name;
const sChanged: boolean = sanitizeResult.changed;
const sHits: FilenameHit[] = sanitizeResult.hits;
const nValid: boolean = nameCheck.valid;
const nHits: FilenameHit[] = nameCheck.hits;
const eError: string = apiError.error;                 // eine Zeichenkette (ein neuer Wert ist additiv, ein entfernter bricht (a))
const eMessage: string = apiError.message;
const aVersion: 1 = api.version;
// Aufrufform und Rückgabe der Methoden: ein neuer Pflichtparameter oder ein neuer Rückgabefall bricht das.
const sanitized: SanitizeResult | ApiError = api.sanitizeName("x", { caller: "c" });
const sanitizedFolder: SanitizeResult | ApiError = api.sanitizeName("x", { caller: "c", kind: "folder" });
const checked: NameCheck | ApiError = api.checkName("x");
const checkedFolder: NameCheck | ApiError = api.checkName("x", { kind: "folder" });

describe("Sanitizer-API v1 ist eingefroren (Typ-Test, gilt beim Übersetzen)", () => {
  it("die Beispiele werden gebaut und tragen ihre Werte", () => {
    expect([sName, sChanged, sHits, nValid, nHits, eError, eMessage, aVersion]).toEqual(["a.md", false, [], true, [hit], "invalid-input", "m", 1]);
    expect([apiError2.error, viaIndex.error]).toEqual(["not-ready", "invalid-input"]);
    expect("name" in sanitized && sanitized.name).toBe("xc");
    expect("name" in sanitizedFolder && sanitizedFolder.name).toBe("xc");
    expect([checked, checkedFolder]).toEqual([{ valid: true, hits: [] }, { valid: true, hits: [] }]);
  });
});
