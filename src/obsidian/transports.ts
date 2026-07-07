import { requestUrl } from "obsidian";
import type { JsonTransport, SseTransport } from "../core/ports";

/**
 * SSE-Streaming über XMLHttpRequest + onprogress (vault-rag-Muster):
 * Obsidians `requestUrl` kann nicht streamen, natives `fetch` ist lint-gesperrt —
 * XHR ist der erlaubte Streaming-Primitive. `responseText` akkumuliert; über
 * `lastIndex` wird nur der neue Tail als ROH-Delta an `onChunk` gereicht
 * (SSE-Parsing macht der LocalLlmClient über das vendorte parseSSE).
 *
 * Vertrag: resolved mit dem HTTP-Status — AUCH bei Nicht-2xx (der Client braucht
 * z. B. den 400 samt Error-Body für den Context-Overflow-Retry, Spec §3.3).
 * AbortSignal → xhr.abort() → Rejection mit Error name="AbortError".
 */
export class XhrSseTransport implements SseTransport {
  postStream(url: string, body: unknown, onChunk: (raw: string) => void, signal: AbortSignal): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const abortError = (): Error => {
        const e = new Error("Aborted");
        e.name = "AbortError";
        return e;
      };
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const xhr = new XMLHttpRequest();
      let lastIndex = 0;
      const pump = (): void => {
        const text = xhr.responseText;
        if (text.length > lastIndex) {
          const delta = text.slice(lastIndex);
          lastIndex = text.length;
          onChunk(delta);
        }
      };
      xhr.open("POST", url);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onprogress = (): void => pump();
      xhr.onerror = (): void => {
        const e = new Error(`vault-crews: Netzwerkfehler POST ${url}`);
        e.name = "StreamNetworkError";
        reject(e);
      };
      xhr.onabort = (): void => reject(abortError());
      xhr.onload = (): void => {
        pump(); // Rest drainen, der ohne onprogress-Event ankam
        resolve(xhr.status);
      };
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
      xhr.send(JSON.stringify(body));
    });
  }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // Nicht-JSON-Body (z. B. Plain-Text-Fehlerseite) → null, Client entscheidet
  }
}

/**
 * Non-Streaming-JSON über Obsidians `requestUrl` (CORS-frei) mit `throw: false`:
 * HTTP-Fehlerstatus wirft nicht, der (Fehler-)Body wird geparst durchgereicht.
 * Netzwerk-Fehler (Server weg) rejecten weiterhin — genau die Unterscheidung,
 * die der LocalLlmClient für ping/listModels/modelInfo braucht.
 */
export class RequestUrlJsonTransport implements JsonTransport {
  async getJson(url: string): Promise<unknown> {
    const r = await requestUrl({ url, method: "GET", throw: false });
    return parseBody(r.text);
  }

  async postJson(url: string, body: unknown): Promise<unknown> {
    const r = await requestUrl({
      url,
      method: "POST",
      throw: false,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseBody(r.text);
  }
}
