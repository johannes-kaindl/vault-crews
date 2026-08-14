// Übersetzungs-Schlüssel für Endpunkt-Zustände. Obsidian-/DOM-frei, node-testbar und in
// `check:pure` gepinnt (UI-STANDARD §6).
//
// Warum das übrig bleibt, nachdem der handgeschriebene Zeilen-Editor dem Kit gewichen ist:
// `classifyEndpointStatus` und `validateEndpointInput` liefern bewusst SPRACHFREIE Marken
// (`refused`, `not-an-llm-api`, …) — das Kit formuliert nicht. Die Zuordnung Marke → Satz
// ist damit Sache des Consumers, und sie ist die einzige Stelle, an der beide Vokabulare
// aufeinandertreffen.
import type { EndpointStatusKind } from "../vendor/kit/endpoint_diagnostics";

/** i18n-Key für einen Endpunkt-Status (Render-Schicht ruft `t(key)`). */
export function statusKindKey(kind: EndpointStatusKind): string {
  return `settings.endpoint.status.${kind}`;
}

/** i18n-Key für eine Eingabe-Warn-Regel (Render-Schicht ruft `t(key)`). */
export function warnRuleKey(rule: string): string {
  return `settings.endpoint.warn.${rule}`;
}
