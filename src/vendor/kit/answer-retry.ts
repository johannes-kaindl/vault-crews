// vendored from code-kit@0.63.0, src/ts/pure/answer-retry.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** One turn of a chat. Structurally the same as the message types of the callers (`ChatMessage` in obsidian-transmute and slide-deck,
 *  `LlmMessage` in vault-crews, `LlmChatMessage` in `web/llm-stream`), so their arrays go in and come out without a conversion; it is
 *  declared here because `pure/` may not import from `web/`. */
export interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What one ask of the model brings back: the text, and whether the model was cut off at its token limit (`finish_reason: length`). */
export interface AskReply {
  content: string;
  /** `true` when the answer was cut off at the limit. Absent counts as `false`. */
  truncated?: boolean | undefined;
}

/** The verdict of a validator on an answer: the parsed value, or the reason in a sentence the model can read. */
export type Verdict<T> = { ok: true; value: T } | { ok: false; problem: string };

export interface RetryEchoOptions {
  /** Cut the echo of the bad answer to this many UTF-16 units (never in the middle of a surrogate pair). Default: no cut. A whole integer
   *  of at least 0; `0` echoes nothing. slide-deck cuts at 2000, obsidian-transmute and vault-crews echo the whole answer. */
  maxEcho?: number | undefined;
}

/** The turns that ask the model again: the history so far, the bad answer as the assistant's turn, then one user turn that names the
 *  problem and ends with the caller's instruction (the part that differs per caller: "a single valid JSON object", "ONLY the deck
 *  markdown", …). The instruction is last on purpose, so it is the freshest thing the model reads.
 *
 *  An empty or whitespace-only answer (and an echo cut down to nothing) is NOT echoed as an empty assistant turn — some APIs reject
 *  empty content; the history then ends in two user turns and the problem still goes out.
 *
 *  Does not change `previous`. Throws `RangeError` for a `maxEcho` that is not a whole number of at least 0.
 *
 *  Origin: `buildRetryPrompt` (obsidian-transmute `core/llm/prompt.ts`), `buildRetryFeedback` (slide-deck, vendored deck-core) and
 *  `buildRepairPrompt` (vault-crews `core/output-validator.ts`). The wording of the lead is English for every caller; vault-crews
 *  passes its German instruction as is. */
export function buildRetryMessages(
  previous: readonly TextMessage[],
  badAnswer: string,
  problem: string,
  instruction: string,
  opts: RetryEchoOptions = {},
): TextMessage[] {
  const echo = cutEcho(badAnswer, opts.maxEcho);
  const out: TextMessage[] = [...previous];
  if (echo.trim() !== "") out.push({ role: "assistant", content: echo });
  out.push({ role: "user", content: `Your previous answer was not valid: ${problem}\n\n${instruction}` });
  return out;
}

function cutEcho(answer: string, maxEcho: number | undefined): string {
  if (maxEcho === undefined) return answer;
  if (!Number.isInteger(maxEcho) || maxEcho < 0) {
    throw new RangeError(`maxEcho must be a whole number of at least 0, got ${String(maxEcho)}`);
  }
  if (answer.length <= maxEcho) return answer;
  const last = answer.charCodeAt(maxEcho - 1);
  // A cut between the two halves of a surrogate pair would leave a lone surrogate, which breaks the JSON body of the next request.
  const inPair = maxEcho > 0 && last >= 0xd800 && last <= 0xdbff;
  return answer.slice(0, inPair ? maxEcho - 1 : maxEcho);
}

export interface AskUntilValidOptions extends RetryEchoOptions {
  /** The turns of the first ask (system prompt, history, the question). Not changed. */
  messages: readonly TextMessage[];
  /** What the model is told to do again, see {@link buildRetryMessages}. */
  instruction: string;
  /** How many times to ask AGAIN after an invalid answer: `0` asks once, `1` at most twice. A whole integer of at least 0 — an
   *  infinite budget never ends against a model that does not comply, so `Infinity` is refused (`RangeError`, before the first ask). */
  maxRetries: number;
  /** Stop at once when an invalid answer was cut off at the token limit: the next ask meets the same limit and burns a call, and the
   *  cause is a budget, not the model (vault-crews). Default `false`: a cut-off answer is retried like any other (slide-deck). A cut-off
   *  answer that is valid is accepted either way. */
  stopOnTruncated?: boolean | undefined;
}

export type AskUntilValidResult<T> =
  | { ok: true; value: T; attempts: number; truncated: boolean }
  | { ok: false; problem: string; raw: string; attempts: number; truncated: boolean };

/** Ask the model; if the answer is not valid, ask again with the bad answer and the reason, up to `maxRetries` times. The result is the
 *  value of the first valid answer, or the problem and the raw text of the LAST answer. `attempts` counts the asks, `truncated` is the
 *  flag of the last answer.
 *
 *  What is retried is an INVALID ANSWER, nothing else: an error thrown by `ask` (server error, abort, overflow) and an error thrown by
 *  `validate` (a bug) come through unchanged and are not retried — a second ask does not change a server state. A caller that wants a
 *  failed ask retried catches it itself. Each retry carries the whole chain (every earlier bad answer and its problem), not only the
 *  last one.
 *
 *  Origin: the three retry loops of obsidian-transmute (`session.ts` `run`, one retry), slide-deck (`generate-deck.ts`, `MAX_RUNS = 2`)
 *  and vault-crews (`orchestrator.ts`, one repair round); SVG Studio asks for "at most twice". */
export async function askUntilValid<T>(
  ask: (messages: TextMessage[]) => Promise<AskReply>,
  validate: (content: string) => Verdict<T>,
  o: AskUntilValidOptions,
): Promise<AskUntilValidResult<T>> {
  if (!Number.isInteger(o.maxRetries) || o.maxRetries < 0) {
    throw new RangeError(`maxRetries must be a whole number of at least 0, got ${String(o.maxRetries)}`);
  }
  let messages: TextMessage[] = [...o.messages];
  for (let attempts = 1; ; attempts++) {
    const reply = await ask(messages);
    const truncated = reply.truncated === true;
    const verdict = validate(reply.content);
    if (verdict.ok) return { ok: true, value: verdict.value, attempts, truncated };
    if (attempts > o.maxRetries || (o.stopOnTruncated === true && truncated)) {
      return { ok: false, problem: verdict.problem, raw: reply.content, attempts, truncated };
    }
    messages = buildRetryMessages(messages, reply.content, verdict.problem, o.instruction, { maxEcho: o.maxEcho });
  }
}
