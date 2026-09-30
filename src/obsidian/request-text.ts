// uebernommen aus lingotuner/src/core/request-text.ts und settings-tab.ts (fieldStateText), 2026-09-30
import { t } from "../vendor/kit/i18n";
import type { Deviation, DeviationKind, FieldExplain } from "../vendor/kit/sampling-profiles";

/** Textbausteine für Abweichungen (Spec § 5.3): eine Zuordnung, von der Sitzungs-Notice UND dem
 *  Abschnitt „Anfrage" (Statuszeile) genutzt — nie zweimal formuliert. */
const KEY: Record<DeviationKind, string> = {
  "thinking-despite-off": "request.dev.thinkingDespiteOff",
  "empty-by-budget": "request.dev.emptyByBudget",
  "family-mismatch": "request.dev.familyMismatch",
  "family-detected": "request.dev.familyDetected",
  "rejected": "request.dev.rejected",
};

export function deviationDetail(kind: DeviationKind, detail?: string): string {
  return detail !== undefined ? t(KEY[kind], detail) : t(KEY[kind]);
}

/** Notice-Text: nur für Abweichungen mit `affectsResult` aufgerufen (Vertrag von
 *  `createRequestSession`). */
export function deviationNotice(d: Deviation): string {
  return `${deviationDetail(d.kind, d.detail)} ${t("request.dev.seeSettings")}`;
}

const STATE_KEY: Record<FieldExplain["state"], string> = {
  "sent-effective": "request.state.sentEffective",
  "sent-unproven": "request.state.sentUnproven",
  "not-sent-ignored": "request.state.notSentIgnored",
  "not-sent-unsupported": "request.state.notSentUnsupported",
  "not-sent-unknown-family": "request.state.notSentUnknownFamily",
  "not-sent-no-value": "request.state.notSentNoValue",
};
const NOTE_KEY: Record<NonNullable<FieldExplain["note"]>, string> = {
  "raised-to-reserve": "request.note.raisedToReserve",
  "raised-to-thinking-floor": "request.note.raisedToThinkingFloor",
  "below-thinking-floor": "request.note.belowThinkingFloor",
  "off-not-possible": "request.note.offNotPossible",
};

/** Beschreibung je Feld: Zustand (gesendet / nicht gesendet und warum), Anmerkung, top_p-Hinweis. */
export function fieldStateText(e: FieldExplain): string {
  let s = t(STATE_KEY[e.state]);
  if (e.note) s += ` ${t(NOTE_KEY[e.note])}`;
  if (e.field === "top_p") s += t("request.top_p.hint");
  return s;
}
