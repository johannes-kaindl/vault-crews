// uebernommen aus lingotuner/src/obsidian/http.ts (cachedProbe, fetchJsonAdapter), 2026-09-30
import { requestUrl } from "obsidian";
import { probeBaseUrl, probeEndpoint as probeBackend, type CapabilityFetch } from "../vendor/kit/capabilities";
import type { BackendId } from "../vendor/kit/sampling-profiles";

const fetchJsonAdapter: CapabilityFetch = async (req) => {
  const res = await requestUrl({ url: req.url, method: req.method ?? "GET", headers: req.headers, body: req.body, throw: false });
  if (res.status < 200 || res.status >= 300) return null;
  try { return { json: JSON.parse(res.text) as unknown }; } catch { return null; }
};

const BACKEND_CACHE_MS = 30_000;
let backendCache: { url: string; backend: BackendId; at: number } | null = null;

/** Welches Backend hinter einer URL steckt — 30 s je URL zwischengespeichert (dieselbe Regel wie
 *  der Modelllisten-Cache), bei Änderung der URL verworfen. Die Anfrage-Profile unterscheiden
 *  nach Backend, also braucht jeder Lauf die Antwort; eine Probe je Lauf-Task wäre ein Umweg je Aufruf. */
export async function cachedProbe(url: string, model: string): Promise<BackendId | null> {
  const now = Date.now();
  if (backendCache && backendCache.url === url && now - backendCache.at < BACKEND_CACHE_MS) return backendCache.backend;
  const { backend } = await probeBackend(fetchJsonAdapter, probeBaseUrl(url), model);
  backendCache = { url, backend, at: now };
  return backend;
}
