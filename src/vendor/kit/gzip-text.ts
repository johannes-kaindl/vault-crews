// vendored from code-kit@0.87.0, src/ts/web/gzip-text.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** Text ↔ gzip bytes over the platform streams: `gzipText(text)` → `Promise<Uint8Array>` and `gunzipText(bytes)` → `Promise<string>`.
 *
 *  ── Why `web` and not `pure` ────────────────────────────────────────────────────────────
 *  `CompressionStream` and `DecompressionStream` are host globals: Node 18 and later, Chromium (Electron, the Obsidian desktop), WebKit
 *  (the iOS web view) and Firefox have them, but a runtime that only promises ECMAScript (an embedded engine, an older Hermes, a test
 *  sandbox) may not, and `pure` is the layer that is callable from anywhere. The names are not on the restricted list of the purity guard, so
 *  the lint would not have caught it: the axis is decided here, by the same question as for `clipboard` (does the contract assume a host
 *  object?). Neither stream is I/O, but the module is still a host-API module, and a consumer that wants gzip without a host brings its own.
 *
 *  ── The contract ────────────────────────────────────────────────────────────────────────
 *  - Byte exact: the text goes through UTF-8 unchanged. U+2011 (non-breaking hyphen), U+202F (narrow no-break space), an emoji (a surrogate
 *    pair), `\r\n`, a BOM, a lone `\r` and the empty string all come back as they went in. (`Response.text()` would have stripped a BOM and
 *    replaced bad sequences; this module reads the bytes itself and decodes with `fatal: true, ignoreBOM: true`.)
 *  - The empty string is a valid round trip (a gzip member with no data, 20 bytes).
 *  - `gunzipText` REFUSES what is not a complete gzip stream: not gzip at all, an empty input, a stream cut at ANY byte (every cut of two
 *    streams measured, the test walks all of them), a stream with bytes behind its trailer. It never returns an empty or partial text for a damaged input. Several
 *    gzip members one after the other are read as one text (what `gzip` and `zlib.gzipSync` concatenated give).
 *  - It REFUSES a valid gzip stream whose content is not UTF-8 (the decoder is `fatal`): a silent U+FFFD in a log is a worse failure than a
 *    refusal. The refusal is an `Error` whose message names the function and carries the platform error as `cause`.
 *  - The tests read the bytes with Node's `zlib.gunzipSync` and write bytes it reads, so a stream is the standard gzip format.
 *
 *  Origin: vault-crews (focus-crew requirement 2, inbox note "Vault Crews — Anforderungen aus focus-crew", 2026-11-17): `calls.jsonl.gz`, the
 *  record of every model call, packed at the end of a run. `naehte_suche.py gzip CompressionStream jsonl`: 0 hits in either library. */

/** Reads a stream to its end into one `Uint8Array`. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** UTF-8 of `text` through gzip. */
export async function gzipText(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  // `Blob.stream()` feeds the compressor and is read from the other end at the same time: no write is awaited before the read starts, so a large
  // text cannot dead-lock on back-pressure.
  return readAll(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip")));
}

/** The text of a complete gzip stream; an `Error` for anything else (see the header: not gzip, empty, cut, trailing bytes, not UTF-8). */
export async function gunzipText(bytes: Uint8Array): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = await readAll(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")));
  } catch (cause) {
    throw new Error(`gunzipText: the input is not a complete gzip stream (${bytes.length} bytes)`, { cause });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch (cause) {
    throw new Error("gunzipText: the gzip content is not valid UTF-8", { cause });
  }
}
