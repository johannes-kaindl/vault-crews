import { requestUrl } from "obsidian";
import type { JsonTransport } from "../core/ports";

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
  async getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const r = await requestUrl({ url, method: "GET", throw: false, headers });
    return parseBody(r.text);
  }

  async postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const r = await requestUrl({
      url,
      method: "POST",
      throw: false,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return parseBody(r.text);
  }
}
