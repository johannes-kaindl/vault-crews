// vendored from obsidian-kit#0.2.0, src/pure/endpoint.ts
/** Normalisiert eine Endpoint-Eingabe: trailing Slashes + ein trailing `/v1` strippen.
 *  Die Clients hängen `/v1/...` selbst an — enthielte der konfigurierte Endpoint bereits
 *  ein `/v1`, entstünde `…/v1/v1/...` (manche Server, z.B. LM Studio, antworten darauf mit
 *  HTTP 200 + Fehler-Body statt einem echten Fehler → still falsche/leere Ergebnisse).
 *  So funktioniert sowohl `http://host:1234` als auch `http://host:1234/v1`.
 *
 *  @example normalizeEndpoint("http://host:1234/v1/") // → "http://host:1234" */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
}

/** Erster erreichbarer Endpoint aus einer geordneten Fallback-Liste, sonst `null`.
 *  Leere/whitespace-Einträge werden übersprungen; jeder Eintrag wird `normalizeEndpoint`-t.
 *  `ping` ist **injiziert** (gibt `true` bei erreichbar) → app-/UI-frei und in Node testbar.
 *
 *  Motivation: ein lokaler LLM-Endpoint wechselt mit dem Netz (localhost am Host vs. LAN-IP
 *  unterwegs). Eine geordnete Liste deckt alle Netze mit *einer* gesyncten Config ab; der
 *  erste erreichbare gewinnt. Diese Funktion macht **einen** Resolver-Durchlauf — die
 *  Failover-Orchestrierung (Caching des aktiven Endpoints, Re-Resolve, Retry) bleibt beim Aufrufer.
 *
 *  @example
 *  await resolveActiveEndpoint(
 *    ["http://localhost:1234", "http://192.168.178.20:1234"],
 *    ep => fetchReachable(ep),
 *  ) // → erster erreichbarer, normalisierter Endpoint oder null */
export async function resolveActiveEndpoint(
  endpoints: string[],
  ping: (endpoint: string) => Promise<boolean>,
): Promise<string | null> {
  for (const raw of endpoints) {
    if (!raw || !raw.trim()) continue;
    const ep = normalizeEndpoint(raw);
    if (await ping(ep)) return ep;
  }
  return null;
}
