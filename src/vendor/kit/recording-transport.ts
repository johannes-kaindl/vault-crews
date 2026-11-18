// vendored from obsidian-kit@0.97.0, src/obsidian/recording-transport.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// recording-transport.ts — ein SseTransport, der einen anderen unverändert durchreicht und danach genau einmal ein Protokoll des Austauschs übergibt.
//
// Kein `obsidian`-Import, und die erste Frage aus AGENTS.md („gehört das nach code-kit?“) ist gestellt: der Vertrag `SseTransport` liegt in
// obsidian-kit (`chat-client.ts`), in code-kit gibt es ihn nicht (gemessen 2026-11-18, `/usr/bin/grep -rln SseTransport ../code-kit/src` ohne Treffer).
// Die Hülle hängt an genau diesem Vertrag, also bleibt sie hier; zieht der Vertrag einmal um, zieht sie mit.
//
// Träger: vault-crews (focus-crew, Erweiterung 2: Mitschnitt der Modellaufrufe), koda-agent und jeder `createChatClient`-Nutzer.
// Bibliotheksbegründung (Gate, Dach-AGENTS): neuer reiner Export ohne plugin-eigenen Typ; `naehte_suche.py recording transport sink mitschnitt` fand 0 Treffer,
// die Gegenprobe `--wie createChatClient` fand `createChatArchive` und die Plugin-Clients, also kann die Suche finden.

import type { SseTransport } from "./chat-client";

/** Ein aufgezeichneter Austausch. **Ohne Kopfzeilen**: in `Authorization` und `x-api-key` steht der Schlüssel, er kommt nie in einen Datensatz. */
export interface TransportExchange {
  url: string;
  /** Der Körper, wie er übergeben wurde (dasselbe Objekt, nicht kopiert, nicht serialisiert). */
  body: unknown;
  /** Der HTTP-Status; `null`, wenn der Aufruf abgelehnt wurde (Netzfehler, Abbruch, ein werfendes `onChunk`). */
  status: number | null;
  /** Die Verkettung aller Rohtext-Abschnitte, die `onChunk` bekam (bei Ablehnung: bis dahin). */
  raw: string;
  startedAt: number;
  endedAt: number;
  /** Nur bei Ablehnung: `name: message` (bei einem Nicht-Error der Text des Wertes). */
  error?: string;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Reicht jeden Aufruf unverändert an `inner` durch (dieselben Chunks in derselben Reihenfolge, derselbe aufgelöste Status, dieselbe Ablehnung als dasselbe Objekt, damit
 *  `name === "AbortError"` und `"StreamNetworkError"` für den Fallback des Clients erhalten bleiben) und übergibt danach **genau einmal** an `sink`, was geschah.
 *  Ein `sink`, der wirft oder eine abgelehnte Zusage zurückgibt, stört den Aufruf nicht. Ein werfendes `onChunk` des Aufrufers erreicht `inner` wie ohne Hülle.
 *  `now` ist die Uhr für `startedAt`/`endedAt` (Standard `Date.now`). */
export function recordingTransport(inner: SseTransport, sink: (x: TransportExchange) => void, now: () => number = Date.now): SseTransport {
  return {
    postStream(url, body, headers, onChunk, signal) {
      const startedAt = now();
      const parts: string[] = [];
      const emit = (status: number | null, error?: string): void => {
        const record: TransportExchange = { url, body, status, raw: parts.join(""), startedAt, endedAt: now() };
        if (error !== undefined) record.error = error;
        try {
          const r: unknown = sink(record);
          if (r !== null && typeof r === "object" && typeof (r as { then?: unknown }).then === "function") {
            (r as PromiseLike<unknown>).then(undefined, () => undefined);
          }
        } catch {
          // Ein Mitschnitt darf den Aufruf nie stören.
        }
      };
      const tee = (raw: string): void => {
        parts.push(raw);
        onChunk(raw);
      };
      let pending: Promise<number>;
      try {
        pending = inner.postStream(url, body, headers, tee, signal);
      } catch (e) {
        emit(null, describeError(e));
        throw e;
      }
      return pending.then(
        (status) => {
          emit(status);
          return status;
        },
        (e: unknown) => {
          emit(null, describeError(e));
          throw e;
        },
      );
    },
  };
}
