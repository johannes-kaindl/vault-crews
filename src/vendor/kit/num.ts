// vendored from code-kit@0.91.1, src/ts/pure/num.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** Parsed einen Integer aus String oder Zahl und clamped ihn nach [min, max].
 *  Nicht-finite/ungültige Eingaben → `fallback`. Floats werden via Math.trunc zu Int (kein Round).
 *  Konsolidiert 5 divergente Inlinings (parseInt/Number/parseFloat) auf EINE Semantik;
 *  kanonische Quelle: kuro-gamification SettingsTab.clampInt (12 Call-Sites).
 *
 *  @example clampInt("42", 0, 100, 7) // → 42
 *  @example clampInt("abc", 0, 100, 7) // → 7 (fallback) */
export function clampInt(value: string | number, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** The number a loose value stands for, or `null`. For fields that arrive as a number or as a
 *  string depending on who wrote them (frontmatter, YAML, model tool arguments, settings text).
 *
 *  Default: a finite number as it is, or a string that consists of **only** a number — decimal
 *  point or comma, optional minus, optional surrounding quotes and blanks (`"2,5"`, `'4'`, ` 7 `).
 *  Everything else is `null`: text with a number in it (`10 Aufgaben`), an empty string, a sign
 *  `+`, `.5`, `5.`, an exponent, a comma and a point together (`1,000.5`), `NaN`, `Infinity`,
 *  booleans, lists, `null`. A lone comma is always a decimal comma: `1,000` is 1, not a thousand.
 *  Without the strictness `true` or `"10 tasks"` would pass as a number.
 *
 *  `prefix: true` adds one reading after the default one found nothing: the leading number of the
 *  string as `parseFloat` reads it (`10 Aufgaben` → 10, `+5` → 5, `.5 x` → 0.5, `1e3 x` → 1000),
 *  and `NaN` / `Infinity` are still `null`. Whatever the default accepts keeps its value, so
 *  `prefix` only ever accepts more. A decimal comma is read only in the whole-string reading:
 *  `2,5 Aufgaben` is 2 under `prefix`, as `parseFloat` would say.
 *
 *  Origin: kuro-gamification `numberFieldValue` (`src/utils/numberFields.ts`), same answers on
 *  every input of the default reading — shown against a verbatim copy of it in the tests. Other
 *  places that read a loose number by hand and could take this over, none of them switched:
 *  vault-crews `collectors.ts` `num` (a number only, strings fall out), koda-agent `parse.ts`
 *  `intIn` (digits only, then a range), koda-agent `vault-tools.ts` `depthOf` and calendar-notes
 *  `contact-commands.ts` `parseIndex` (both `Number(v)`, which reads `""` and blanks as 0, where
 *  this returns `null`), obsidian-letterhead `settings.ts` (`Number(String(v).replace(',', '.'))`,
 *  the same comma rule but also `""` as 0 and text as `NaN`). A caller that relied on `""` being 0
 *  keeps that on its own side: `parseNumeric(v) ?? 0` is not the same thing for `"abc"`.
 *
 *  @example parseNumeric("2,5") // → 2.5
 *  @example parseNumeric('"3"') // → 3
 *  @example parseNumeric("10 Aufgaben") // → null
 *  @example parseNumeric("10 Aufgaben", { prefix: true }) // → 10 */
export function parseNumeric(raw: unknown, opts: { prefix?: boolean } = {}): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/^(["'])(.*)\1$/, "$2").trim().replace(",", ".");
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (opts.prefix !== true) return null;
  const lead = Number.parseFloat(raw);
  return Number.isFinite(lead) ? lead : null;
}
