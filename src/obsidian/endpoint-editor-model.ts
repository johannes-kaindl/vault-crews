// Pure Logik des Endpoint-/Modell-Editors (Ansatz A, UI-STANDARD §6): obsidian-/DOM-frei,
// node-testbar und in `check:pure` gepinnt. Die Render-Schicht (settings.ts) ruft diese
// Funktionen und bleibt dünn.
import type { EndpointStatusKind } from "../vendor/kit/endpoint_diagnostics";

/** Wendet eine Zeilen-Editor-Änderung auf eine Endpoint-/Denied-Liste an.
 *  - trimmt den Wert;
 *  - `isAdder` (letzte Leerzeile) hängt einen nicht-leeren Wert an, ein leerer Wert ist No-Op;
 *  - eine bestehende Zeile mit geleertem Wert wird entfernt, sonst an ihrer Stelle ersetzt;
 *  - am Ende werden alle Leereinträge herausgefiltert (roundtrip-treu, nie leere Zeilen persistiert). */
export function applyEndpointEdit(
  list: string[],
  index: number,
  value: string,
  isAdder: boolean,
): string[] {
  const v = value.trim();
  let next: string[];
  if (isAdder) {
    next = v ? [...list, v] : [...list];
  } else {
    next = [...list];
    if (v) next[index] = v;
    else next.splice(index, 1);
  }
  return next.filter((e) => e.trim().length > 0);
}

/** Index der ersten Zeile mit Status `ok` (= aktiver Endpoint, exakt resolveActiveEndpoint-
 *  Semantik: erster erreichbarer gewinnt), sonst `-1`. `null` = noch nicht geprobt. */
export function activeIndexFromStatuses(statuses: (EndpointStatusKind | null)[]): number {
  return statuses.findIndex((s) => s === "ok");
}

/** Modus des Standardmodell-Feldes: `dropdown`, sobald Modelle geladen sind und das
 *  gespeicherte Modell leer oder in der Liste ist; sonst `freetext` (offline oder das
 *  gespeicherte Modell listet die API nicht) — nie ein toter Zustand. */
export function modelFieldMode(models: string[], saved: string): "dropdown" | "freetext" {
  if (models.length === 0) return "freetext";
  return saved === "" || models.includes(saved) ? "dropdown" : "freetext";
}

/** i18n-Key für einen Endpoint-Status-Kind (Render-Schicht ruft `t(key)`). */
export function statusKindKey(kind: EndpointStatusKind): string {
  return `settings.endpoint.status.${kind}`;
}

/** i18n-Key für eine Eingabe-Warn-Regel (Render-Schicht ruft `t(key)`). */
export function warnRuleKey(rule: string): string {
  return `settings.endpoint.warn.${rule}`;
}
