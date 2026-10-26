// vendored from code-kit@0.38.0, src/ts/pure/list-summary.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** The first `max` items of a list and the number of the others — the cut every "a, b, c (+3)" and "… and 3 more" makes before it words
 *  the rest. The wording stays the caller's (language, separator, where the count goes); this is the arithmetic, once.
 *
 *  Origin: seven carriers of the same cut, read 2026-10-25 — vault-rag `index_notices.ts` (`formatPathList`, default 5), 3d-codeblocks
 *  `core/shapes/convert.ts` (`capList`) and `core/gltf-uri.ts:99`, finance-ledger `core/import/formatHints.ts:44`, koda-agent
 *  `core/tools/list.ts:220/245`, calendar-notes `core/api/tool-provider.ts:150/159`, vault-crews `core/collectors.ts:37`. The gate reviewer
 *  refused a fourth private copy (Welle 27). None is switched here (Cockpit task).
 *
 *  **Where the copies differ, and what this does:** for a whole-number `max` of 1 or more they all cut the same way (the first `max`, the
 *  rest counted as `length - shown`). At the edges they do not: a negative `max` makes `slice(0, max)` cut from the END (`formatPathList(
 *  ["a", "b", "c"], -1)` shows "a, b" and counts a rest of 4), a `NaN` makes `length > max` false and the list vanishes without a word,
 *  `max` 0 gives a leading space (`" (+3)"`), and koda-agent clamps to at least 1 (`Math.max(1, subfolderMax)`) while the others show
 *  nothing. Here: a `max` below 1 or `NaN` is 0 — nothing shown, everything counted; a fractional `max` is rounded down; `Infinity` shows
 *  all. A caller that wants koda's "at least one" passes `Math.max(1, max)`. */
export interface ListSummary<T> {
  /** A new array: the first `max` items, in order. */
  shown: T[];
  /** How many items were left out (0 when the list fits). */
  rest: number;
}

export function summarizeList<T>(items: readonly T[], max: number): ListSummary<T> {
  // `slice` cuts a fraction off (2.9 → 2) and reads NaN as 0 by itself; only a negative end needs the guard (it would count from the tail)
  const shown = items.slice(0, Math.max(0, max));
  return { shown, rest: items.length - shown.length };
}
