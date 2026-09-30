import type { RequestPort } from "../core/ports";
import type { EndpointConfig } from "../vendor/kit/endpoint_config";
import { describeModel, type EndpointSourceResult } from "../vendor/kit/endpoint-source";
import type { RequestSession } from "../vendor/kit-obsidian/request-session";
import type { RequestSectionState } from "../vendor/kit-obsidian/request-section";
import type { BackendId } from "../vendor/kit/sampling-profiles";

export interface RequestPortDeps {
  /** Ergebnis der letzten Quellenwahl gegen den LLM Endpoint Manager (null ohne Manager). Nur
   *  damit kennt die Obsidian-Schicht die Modell-Tabelle des Managers: Familie und Alias. */
  managerSource(): EndpointSourceResult | null;
  /** Backend hinter einer URL (Probe, zwischengespeichert). */
  probe(url: string, model: string): Promise<BackendId | null>;
  session: RequestSession;
}

/** Die Obsidian-Seite des `RequestPort`: beantwortet dem puren Orchestrator, welche Familie und
 *  welches Backend hinter dem Modell des Laufs stecken, und hält das Ergebnis für den Abschnitt
 *  „Anfrage" fest — der Orchestrator wählt den Endpunkt per Failover selbst, die Einstellungen
 *  kennen ihn deshalb erst, wenn ein Lauf (oder `seed`) ihn aufgelöst hat. */
export function createRequestPort(deps: RequestPortDeps): { port: RequestPort; state(): RequestSectionState; seed(src: EndpointSourceResult): void } {
  let held: RequestSectionState | null = null;
  const merge = (patch: Partial<RequestSectionState>): void => {
    held = {
      family: null, familySource: "none", backend: "unknown", backendSource: "none", model: "", sentModel: "",
      ...(held ?? {}), ...patch,
    };
  };
  const port: RequestPort = {
    describe(model) {
      const ms = deps.managerSource();
      // Die Tabelle des Managers kennt das Kit-Ergebnis nur für das Modell der Wahl; ein Agent mit
      // anderem Modell bekommt die Schätzung aus dem Namen (`describeModel` ohne Tabelle).
      const d = ms !== null && ms.model === model
        ? { family: ms.family, familySource: ms.familySource, sentModel: ms.sentModel }
        : describeModel(model, undefined);
      merge({
        family: d.family, familySource: d.familySource, model, sentModel: d.sentModel,
        ...(ms?.defaultModel !== undefined ? { defaultModel: ms.defaultModel } : {}),
      });
      return { family: d.family, sentModel: d.sentModel };
    },
    async backendOf(endpoint: EndpointConfig) {
      const ms = deps.managerSource();
      if (ms !== null && ms.backendSource === "manager") {
        merge({ backend: ms.backend, backendSource: "manager" });
        return ms.backend;
      }
      let b: BackendId | null = null;
      try { b = await deps.probe(endpoint.url, endpoint.model ?? ""); } catch { /* bleibt unbekannt */ }
      merge(b !== null && b !== "unknown" ? { backend: b, backendSource: "probe" } : { backend: "unknown", backendSource: "none" });
      return b ?? "unknown";
    },
    recordRequest: (params) => deps.session.recordRequest(params),
    report: (ds) => deps.session.report(ds),
  };
  return {
    port,
    state: () => held ?? { family: null, familySource: "none", backend: "unknown", backendSource: "none", model: "", sentModel: "" },
    seed(src) {
      merge({
        family: src.family, familySource: src.familySource, backend: src.backend, backendSource: src.backendSource,
        model: src.model, sentModel: src.sentModel,
        ...(src.defaultModel !== undefined ? { defaultModel: src.defaultModel } : {}),
      });
    },
  };
}
