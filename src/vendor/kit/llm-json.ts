// vendored from code-kit@0.38.0, src/ts/pure/llm-json.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Origin: four plugin copies (Welle 18, analysis K9, measured 2026-10-12): obsidian-transmute `core/llm/response.ts:65-95`
// (`stripFence`, `firstJsonObject`; 2026-07-25), koda-agent `core/agent/text-fallback.ts:6-35` (a line-for-line copy of
// transmute), 3d-codeblocks `core/shapes/protocol.ts:52-120` (`balancedEnd`, `extractJson` with several candidates,
// linear since 64bf62f — the reference) and vault-crews `core/output-validator.ts:14-75` (`findBalanced`, `extractJson`
// with a repair pass; 2026-07-02, the oldest).
import { stripThinkBlocks, type StripThinkOptions } from "./think-splitter";

/** Options of {@link extractJsonCandidates} and {@link firstJsonObject}. Every default is the behaviour of
 *  3d-codeblocks, which is the reference (its 32 protocol tests are the yardstick); the other three carriers
 *  keep theirs with the option named next to it. */
export interface LlmJsonOptions {
  /** What happens to `<think>` blocks before anything is read. Default
   *  `{ dropStrayClose: true, dropUnclosed: true }`: pairs go, everything up to the LAST stray `</think>` goes, and an
   *  UNCLOSED `<think>` drops the rest of the text — its brackets come from the thought, not from the answer
   *  (decided by Johannes 2026-10-12; transmute, koda and crews used to read a JSON behind an unclosed block).
   *  Pass other {@link StripThinkOptions} to loosen that, or `false` when the text is already stripped. */
  think?: StripThinkOptions | false;
  /** Where candidates are looked for.
   *  - `"all"` (default, 3d-codeblocks): every fenced block in reading order, then the whole text.
   *  - `"first"` (transmute, koda-agent): only the first fenced block.
   *  - `"last"` (vault-crews): only the last fenced block — reasoning models quote the example of the format in the
   *    preamble, the real answer is the last block.
   *  With `"first"` and `"last"` the whole text is read only when there is NO fenced block (that includes a fence
   *  that never closes — truncated output). A fence is three backticks, an optional tag line, a line break, then the
   *  body up to the next three backticks. */
  fence?: "all" | "first" | "last";
  /** Which fences count. `"any"` (default, every fence, with or without a language tag) or `"json"` (only a block
   *  tagged `json`, vault-crews). */
  fenceTag?: "any" | "json";
  /** Tolerate what models get wrong (vault-crews: "every LLM output is hostile input"). Default `false`. When no
   *  candidate parses strictly, the text is read a second time with typographic quotes (`“ ” „ ‘ ’ ‚`) turned into
   *  ASCII ones (the indexes stay the same, one character for one) and a trailing comma before `}` or `]` dropped.
   *  The second pass runs only when the first found nothing, so a text that parses is never touched. */
  repair?: boolean;
  /** Whether `[…]` may be a candidate. Default `true` (3d-codeblocks and crews read a bare list); `false` only
   *  starts at `{` (transmute and koda want one object; {@link firstJsonObject} always sets it). */
  allowArray?: boolean;
}

/** The result of {@link extractJsonCandidates}.
 *
 *  `values` are the candidates in READING ORDER: with `fence: "all"` first the ones inside fenced blocks, in block
 *  order, then the ones of the whole text. **The same JSON can therefore appear twice** — once from its fence, once
 *  from the whole text — and a JSON inside a fence of the quoted example comes before the real answer. A caller
 *  takes the first candidate that satisfies ITS schema (3d-codeblocks does exactly that), not `values[0]` blindly.
 *
 *  `truncated: true` on success: some bracket was opened and never closed (the answer was cut off), although
 *  another candidate was found. On failure `reason` says why nothing was found; `"truncated"` wins over
 *  `"invalid-json"` when both apply, and `error` is the message of the last `JSON.parse` that threw, if any. */
export type JsonCandidates =
  | { ok: true; values: unknown[]; truncated: boolean }
  | { ok: false; reason: "no-json" | "invalid-json" | "truncated"; error?: string };

const DEFAULT_THINK: StripThinkOptions = { dropStrayClose: true, dropUnclosed: true };
const FENCE = "```";

/** The bodies of the closed fenced blocks, in order. A fence is three backticks, a tag line (anything up to the line
 *  break, no backtick in it), a line break, and the body up to the next three backticks — the rule of 3d-codeblocks'
 *  `/```[^\n`]*\n([\s\S]*?)```/g`, written with `indexOf` so nothing backtracks. A fence on one line
 *  (```` ```{"a":1}``` ````) is no block; the brackets in it are still read as part of the whole text. */
function fencedBodies(text: string, jsonOnly: boolean): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf(FENCE, from);
    if (open < 0) return bodies;
    let p = open + FENCE.length;
    const tagStart = p;
    while (p < text.length && text.charCodeAt(p) !== 10 && text.charCodeAt(p) !== 96) p++;
    if (text.charCodeAt(p) !== 10) {
      from = open + 1; // a backtick or the end of the text before a line break: not an opener, look on
      continue;
    }
    const close = text.indexOf(FENCE, p + 1);
    if (close < 0) return bodies; // never closed: not a block (the whole text still sees its brackets)
    if (!jsonOnly || text.slice(tagStart, p).trim().toLowerCase() === "json") bodies.push(text.slice(p + 1, close));
    from = close + FENCE.length;
  }
}

/** For the `[` or `{` at `start`: the index of its partner (a closer of either kind pops the innermost opener,
 *  strings and `\` escapes inside strings are skipped), `null` if it stays open. One walk fills `ends` for EVERY
 *  opener it passes outside a string — a fresh walk from one of those would read the same state — which is what
 *  makes the search linear instead of quadratic with many open brackets (`"[1,".repeat(50000)`). `ends` is shared
 *  over all calls on one source. (3d-codeblocks `balancedEnd`, 64bf62f.)
 *
 *  The memo is not enough on its own: in `\"[` repeated, no opener is ever outside a string for an earlier walk (the
 *  escape eats the closing quote), so every opener starts a walk to the end of the text — quadratic, found by a
 *  fuzz over all units of up to three characters (`'\\"['.repeat(40000)` in JS: 3.5 s, and the same for 3d-codeblocks'
 *  own function). `meter` counts the characters walked; {@link scanSources} stops when it passes the budget. */
function balancedEnd(s: string, start: number, ends: Map<number, number | null>, meter: Meter): number | null {
  const known = ends.get(start);
  if (known !== undefined) return known;
  const open: number[] = [];
  let inString = false;
  let i = start;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") open.push(i);
    else if (c === "]" || c === "}") {
      const opener = open.pop();
      if (opener === undefined) break;
      ends.set(opener, i);
      if (open.length === 0) {
        meter.work += i - start + 1;
        return i;
      }
    }
  }
  meter.work += Math.min(i, s.length) - start;
  for (const opener of open) ends.set(opener, null);
  return ends.get(start) ?? null;
}

/** Characters walked (and characters handed to `JSON.parse`) on one source. */
interface Meter { work: number }

/** The work one source may cost, in characters: twelve passes over the text plus a floor of 65 536.
 *
 *  **Why a budget at all.** The `ends` memo of {@link balancedEnd} makes the search linear for every text where the
 *  openers are read from a known state — and a model answer is untrusted input, so it has to hold for the rest too.
 *  A fuzz over every unit of up to three characters found two families where it does not (measured 2026-10-12 on
 *  3d-codeblocks' own function, `readPartsAnswer`, at 2 000 / 10 000 / 20 000 repetitions):
 *  - **a** `\"[` repeated: the escape eats the closing quote of every string, so no opener is ever outside a string
 *    for an earlier walk and every one of them walks to the end of the text. 9 / 138 / 604 ms (3.5 s at 40 000).
 *  - **b** `[` × n, `x`, `]` × n: every nested span is balanced and fails to parse at the same place, so each
 *    `JSON.parse` reads down to it again one level further in. 24 / 488 / 1 809 ms. The control `[1,` repeated
 *    stays at 0 / 1 / 1 ms.
 *  Both are quadratic: 5 times the input is 25 times the time.
 *
 *  **What it costs a real answer: nothing.** A text of up to about 360 characters cannot reach the floor even when
 *  every opener walks to the end, so every short text is read exactly (the 110 000 strings of the differential test
 *  against 3d-codeblocks' function are such texts), and a long ordinary answer is a few passes (the walk, the
 *  `JSON.parse` of the candidates): 2 MB of valid JSON behind prose with stray brackets and quotes is read in full
 *  with `truncated: false` (test).
 *
 *  **What happens past it.** The search for THIS source stops. What was found stays in `values`, `truncated` is set
 *  (some of the text was not read), and with nothing found the reason is `"truncated"`. The other sources (the whole
 *  text after the fences, or the repair pass) have their own budget. */
const budgetFor = (length: number): number => 12 * length + 65_536;

const normalizeQuotes = (s: string): string => s.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'");
const dropTrailingCommas = (s: string): string => s.replace(/,\s*([}\]])/g, "$1");

interface Scan {
  values: unknown[];
  /** a bracket was opened and never closed */
  truncated: boolean;
  /** a balanced span existed but did not parse */
  broken: boolean;
  error: string | undefined;
}

function scanSources(sources: readonly string[], allowArray: boolean, repair: boolean): Scan {
  const scan: Scan = { values: [], truncated: false, broken: false, error: undefined };
  const fail = (e: unknown): void => {
    scan.broken = true;
    scan.error = e instanceof Error ? e.message : String(e);
  };
  for (const src of sources) {
    const ends = new Map<number, number | null>();
    const meter: Meter = { work: 0 };
    const budget = budgetFor(src.length);
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c !== "{" && !(allowArray && c === "[")) continue;
      if (meter.work > budget) {
        scan.truncated = true; // out of budget: the rest of this source stays unread
        break;
      }
      const end = balancedEnd(src, i, ends, meter);
      if (end === null) {
        scan.truncated = true;
        continue;
      }
      const span = src.slice(i, end + 1);
      meter.work += span.length;
      try {
        scan.values.push(JSON.parse(span));
        i = end; // nothing nested is a candidate of its own again
        continue;
      } catch (e) {
        fail(e);
      }
      if (repair) {
        meter.work += span.length;
        try {
          scan.values.push(JSON.parse(dropTrailingCommas(span)));
          scan.broken = false;
          i = end;
        } catch (e) {
          fail(e);
        }
      }
    }
  }
  return scan;
}

/** All readable JSON candidates of a model answer, in reading order (see {@link JsonCandidates}). Strips `<think>`
 *  first ({@link LlmJsonOptions.think}), picks the sources ({@link LlmJsonOptions.fence}) and walks each one for
 *  balanced `{…}`/`[…]` spans. A span that parses is a candidate and the walk continues behind it; a span that does
 *  not (a bracket in prose: `see [1] and {x}`) is skipped and the walk goes on one character further, so prose before
 *  the JSON does not hide it.
 *
 *  **Linear in the text** — a stray `<think>` or bracket repeated 50 000 times takes milliseconds (measured, see the
 *  tests), and for a text built to defeat the search the work is capped at a multiple of its length (see `budgetFor`).
 *  A text of many tiny balanced spans that do not parse (`"{]".repeat(n)`) costs one `JSON.parse` that throws per span,
 *  which is linear in the number of spans but not free (about 80 ms for 50 000).
 *
 *  Not a schema check and not a repair of structure: the caller validates what it gets. */
export function extractJsonCandidates(raw: string, opts: LlmJsonOptions = {}): JsonCandidates {
  const think = opts.think === undefined ? DEFAULT_THINK : opts.think;
  const text = think === false ? raw : stripThinkBlocks(raw, think);
  const allowArray = opts.allowArray ?? true;
  const mode = opts.fence ?? "all";
  const jsonOnly = opts.fenceTag === "json";

  const bodies = fencedBodies(text, jsonOnly);
  const pick = (t: string, fenced: readonly string[]): string[] => {
    if (mode === "all") return [...fenced, t];
    if (fenced.length === 0) return [t];
    const one = mode === "first" ? fenced[0] : fenced[fenced.length - 1];
    return [one ?? t];
  };

  let scan = scanSources(pick(text, bodies), allowArray, false);
  if (scan.values.length === 0 && opts.repair === true) {
    // Typographic quotes map one character to one, so the spans keep their places. The fences are found again on the
    // normalized text (a ``` does not change), which keeps `pick` honest.
    const normalized = normalizeQuotes(text);
    scan = scanSources(pick(normalized, fencedBodies(normalized, jsonOnly)), allowArray, true);
  }
  if (scan.values.length > 0) return { ok: true, values: scan.values, truncated: scan.truncated };
  const error = scan.error === undefined ? {} : { error: scan.error };
  if (scan.truncated) return { ok: false, reason: "truncated", ...error };
  if (scan.broken) return { ok: false, reason: "invalid-json", ...error };
  return { ok: false, reason: "no-json" };
}

/** The first candidate that is a JSON OBJECT, parsed — for a caller that wants exactly one object (a tool call, a
 *  rule draft). Arrays never count (`allowArray` is off). **It returns the parsed object**; transmute and koda-agent
 *  used to return the raw text of the span and parse it themselves. Everything else is {@link extractJsonCandidates};
 *  use that where the reason for a miss is needed. */
export function firstJsonObject(raw: string, opts: Omit<LlmJsonOptions, "allowArray"> = {}): Record<string, unknown> | null {
  const r = extractJsonCandidates(raw, { ...opts, allowArray: false });
  if (!r.ok) return null;
  const first = r.values[0];
  return typeof first === "object" && first !== null && !Array.isArray(first) ? (first as Record<string, unknown>) : null;
}
