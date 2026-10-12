// vendored from obsidian-kit@0.57.0, src/obsidian/hub.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
import { setIcon } from "obsidian";

/**
 * Hub-Tab-Leiste (UI-STANDARD §4, Muster „mount-once"): eine Tab-Leiste plus
 * Content-Bereich, in den jedes Panel **genau einmal** gemountet wird; der Tab-Wechsel
 * blendet nur um (`is-hidden`), damit interner Panel-Zustand (Chat-Stream, Eingaben,
 * Scrollposition) den Wechsel überlebt.
 *
 * ## Kanonische Quelle
 * `vault-rag/src/hub_view.ts` (`VaultRetrievalView.buildInto`) — Umbruch-Rezept aus
 * `vault-rag` `d0ecbc7`, 2026-07-07 („fix(hub): Tab-Leiste umbruchfähig (kein Overflow
 * bei schmaler Sidebar) + Icons").
 *
 * ## Zusammengeführte Fassungen (Stand 2026-08-20)
 * - `vault-rag/src/hub_view.ts` + `styles.css` (`.vault-rag-hub-*`) — Kanon; liefert
 *   `notifyFileOpen` und den Fallback auf `panels[0]`, wenn der persistierte Tab kein
 *   gebautes Panel hat.
 * - `finance-ledger-plugin/26-011-finanzplan-plugin/src/views/hub/hubController.ts`
 *   (`buildHubInto`, 2026-07-12) + `styles.css` (`.fl-hub-*`) — nach Präfix-Neutralisierung
 *   byte-gleiches CSS; liefert zusätzlich `refreshActive()`, den Guard gegen unbekannte
 *   Tab-Ids in `setTab`, `box-shadow: none` am Tab und `onShow(): void | Promise<void>`.
 *   Seine Root-Zusatzklasse (`finance-plugin`, Design-Scope) ist hier `opts.rootClasses`.
 * - `local-image-generator/src/obsidian/hub.ts` (2026-07-17) — deklariert vendorierte
 *   Kopie des vault-rag-Rumpfs (32 Zeilen identisch), trägt den Extraktionsauftrag in
 *   Zeile 1. Nur zwei Tabs, dafür mit **gerissenem DOM↔CSS-Vertrag** (s. u.).
 * - `vim-dojo/styles.css` (`aef666b`, 2026-08-15) — hat denselben Overflow-Bug fünf Wochen
 *   nach vault-rag unabhängig gefunden und nur 2 der 4 Zutaten übernommen. Rendert über
 *   Preact/JSX und kann `buildHubInto` strukturell **nicht** nehmen; für vim-dojo,
 *   `apple-health` und `kuro-gamification` gilt nur die Regel in `UI-STANDARD.md` §4.
 *
 * ## Das Umbruch-Rezept: vier Zutaten, jede einzeln wirkungslos
 * `display: flex` allein reicht nicht — eine zu schmale Leiste schiebt die letzten Tabs
 * aus dem Panel, wo sie unerreichbar sind (vim-dojo: „the 5th tab (UPLINK) was simply
 * unreachable in a narrow sidebar"). Vollständig ist erst:
 * 1. `flex-wrap: wrap` am Container — erlaubt überhaupt eine zweite Zeile.
 * 2. `flex: 1 1 auto` am Tab — Basis „Inhaltsbreite"; nur dadurch geht die Tab-Breite in
 *    die Umbruch-Entscheidung ein (s. Falle 2).
 * 3. `min-width: 0` am Tab — hebt die automatische Mindestbreite (`min-width: auto` =
 *    min-content) auf, sonst kann ein einzelner Tab mit langem Label die Zeile trotz
 *    `wrap` breiter machen als das Panel.
 * 4. `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` am **Label-Span** —
 *    sonst quillt der Text aus dem geschrumpften Tab. Der Span bekommt seine
 *    Mindestbreite 0 durch `overflow: hidden` geschenkt, der Button (overflow sichtbar)
 *    nicht — deshalb sind (3) und (4) zwei Zutaten und nicht eine.
 *
 * ## Fallen beim Übernehmen
 * 1. **Das Kit injiziert kein CSS.** `HUB_CSS` gehört in die `styles.css` des Consumers
 *    (Muster von `COLLAPSIBLE_CSS`/`ENDPOINT_LIST_CSS`). Ohne sie ist die Leiste nicht nur
 *    ungestylt — der Overflow-Bug ist zurück.
 * 2. **`flex: 1` und `flex-wrap: wrap` heben sich gegenseitig auf.** `flex: 1` ist
 *    `1 1 0%`: die hypothetische Hauptgröße jedes Tabs ist 0, also passen sie *immer* alle
 *    in eine Zeile und schrumpfen unter ihr Label, statt umzubrechen. „Gleich breite Tabs"
 *    (`flex-basis: 0`) und „umbrechende Tabs" (`flex-basis: auto`) sind daher keine
 *    Geschmacksvarianten, sondern Gegenteile — `flex: 1 1 auto` niemals zu `flex: 1`
 *    „vereinfachen". Genau dieser Drift steht heute in `local-image-generator/styles.css`.
 * 3. **Das Label braucht ein eigenes Element.** Nackter Text im `<button>` (vim-dojo)
 *    kann nicht ellipsieren. `local-image-generator` und `apple-health` erzeugen den
 *    Label-Span, haben aber **keine** Regel dafür — ein toter DOM-Haken, der erst beim
 *    dritten Tab bzw. in einer schmalen Sidebar auffällt.
 * 4. **`root` bekommt genau zwei Kinder** (Tab-Leiste, Content) — Consumer-Tests
 *    traversieren nach Index (`root.children[1]` = Content).
 * 5. **`destroy()` leert `root` nicht**, es ruft nur `panel.destroy()`. Das `contentEl.empty()`
 *    bleibt beim Host-`ItemView`, wie in allen drei Quellen.
 * 6. **Roving tabindex:** inaktive Tabs sind bewusst nicht per Tab-Taste erreichbar
 *    (ARIA-Tabs-Muster, s. u.) — ein GUI-Smoke, der sich per Tab durch die Leiste hangelt,
 *    muss auf Pfeiltasten umgestellt werden.
 *
 * ## Was hier über alle Quellen hinausgeht: das ARIA-Tabs-Muster
 * Zwei der sechs Leisten im Bestand deklarieren es halb (vim-dojo: `role="tablist"` +
 * `aria-selected`, keine Pfeiltasten; apple-health: `role="tab"` ohne `tablist`-Elter,
 * also ungültig). Halb deklariert ist schlechter als gar nicht: wer `tablist` liest,
 * erwartet Pfeiltasten-Navigation. Deshalb hier vollständig — `tablist`/`tab`/`tabpanel`,
 * `aria-selected`, `aria-controls`/`aria-labelledby`, roving tabindex und
 * Links/Rechts/Home/End mit automatischer Aktivierung (billig, weil die Panels ohnehin
 * gemountet sind). Hoch/Runter bleiben ungebunden: die Leiste bricht um, eine stabile
 * vertikale Ordnung gibt es also nicht.
 */

/** Ein Panel im Hub. Kein `ItemView` — es bekommt seinen Container injiziert, bleibt
 *  gemountet und wird beim Tab-Wechsel nur per `is-hidden` aus-/eingeblendet. */
export interface HubPanel<Id extends string = string> {
  /** Stabile Tab-Id; zugleich `data-tab`-Attribut an Button und Panel-Div. Eindeutig. */
  readonly id: Id;
  /** Tab-Beschriftung. Implementierungen liefern sie als Getter (`get label()`), damit die
   *  Sprachwahl aus dem `onload` greift und nicht der Import-Zeitpunkt gewinnt. */
  readonly label: string;
  /** Lucide-Name für `setIcon` (UI-STANDARD §4: Icon **und** Label, nicht Text-only). */
  readonly icon: string;
  /** Einmaliger Aufbau in den übergebenen Container. Synchron; async-Init intern via `void`. */
  mount(container: HTMLElement): void;
  /** Tab wird sichtbar (auch initial für den Default-Tab und bei `refreshActive`).
   *  Rückgabe `Promise<void>` erlaubt (finance-Obermenge) — der Hub feuert und wartet nicht. */
  onShow?(): void | Promise<void>;
  /** Tab wird versteckt — laufende Arbeit pausieren. */
  onHide?(): void;
  /** Aktive Notiz gewechselt (zentral über `notifyFileOpen`). Nur kontextsensitive Panels. */
  onFileOpen?(path: string | null): void;
  /** Cleanup: Timer/Intervalle/Streams abbrechen. */
  destroy(): void;
}

/** Steuerkanal des Hubs für den Host-`ItemView`, die Befehlspalette und Deep-Links. */
export interface HubController<Id extends string = string> {
  /** Aktiver Tab — Quelle für `getState()`/Layout-Persistenz. */
  currentTab(): Id;
  /** Tab aktivieren. No-op, wenn `id` bereits aktiv ist **oder** kein Panel dazu existiert
   *  (persistierter Zustand eines abgeschalteten Features). `onHide` alt → `onShow` neu. */
  setTab(id: Id): void;
  /** `onShow` des aktiven Panels erneut auslösen — z. B. nach einem CSV-Import oder wenn
   *  ein Deep-Link auf dem bereits aktiven Tab landet. */
  refreshActive(): void;
  /** Kontextwechsel an alle Panels durchreichen (Panels ohne `onFileOpen` ignorieren es). */
  notifyFileOpen(path: string | null): void;
  /** `destroy()` auf allen Panels. Leert `root` **nicht** — das bleibt beim Host-View. */
  destroy(): void;
}

export interface HubOptions {
  /** Zusätzliche Klassen am Root für einen plugin-eigenen Design-Scope (z. B.
   *  `['finance-plugin']`). Die `okit-hub-*`-Grammatik bleibt davon unberührt. */
  rootClasses?: readonly string[];
}

/** Instanzzähler für kollisionsfreie `id`-Attribute (`aria-controls`/`aria-labelledby`),
 *  falls zwei Hubs gleichzeitig im Dokument hängen (zwei Leaves desselben Views). */
let hubInstanceSeq = 0;

/**
 * Baut die Hub-Tab-Leiste samt Panels in `root` und gibt den Steuerkanal zurück.
 * Reine Aufbau-/Navigationslogik ohne `ItemView` — im Node-Env mit dem Obsidian-Mock
 * testbar, wie in allen drei Quell-Repos.
 *
 * `defaultTab` darf einen Tab nennen, für den kein Panel gebaut wurde (abgeschaltetes
 * Feature im persistierten Layout-State) — dann greift `panels[0]`, sonst bliebe der Hub
 * blank.
 *
 * @example
 * const ctrl = buildHubInto(this.contentEl, panels, this.navState);
 * ctrl.setTab("chat");
 * @example  // eigener Design-Scope am Root, zusätzlich zu okit-hub-root
 * buildHubInto(root, panels, "dashboard", { rootClasses: ["finance-plugin"] });
 */
export function buildHubInto<Id extends string>(
  root: HTMLElement,
  panels: readonly HubPanel<Id>[],
  defaultTab: Id,
  opts?: HubOptions,
): HubController<Id> {
  root.empty();
  root.addClass("okit-hub-root");
  for (const cls of opts?.rootClasses ?? []) root.addClass(cls);

  const uid = `okit-hub-${++hubInstanceSeq}`;
  const tabsEl = root.createDiv({ cls: "okit-hub-tabs", attr: { role: "tablist" } });
  const contentEl = root.createDiv({ cls: "okit-hub-content" });

  const panelDivs = new Map<Id, HTMLElement>();
  const tabBtns = new Map<Id, HTMLElement>();
  /** Zeichenreihenfolge der Tabs — Grundlage der Pfeiltasten-Navigation. */
  const order: Array<{ id: Id; btn: HTMLElement }> = [];

  // Persistierter Layout-State kann einen Tab referenzieren, dessen Panel nicht gebaut
  // wurde (z. B. "smart-apply" bei deaktiviertem Feature) — ohne Fallback bliebe der Hub blank.
  let navState: Id = panels.some((p) => p.id === defaultTab)
    ? defaultTab
    : (panels[0]?.id ?? defaultTab);

  const applyVisibility = (): void => {
    for (const [id, div] of panelDivs) div.toggleClass("is-hidden", id !== navState);
    for (const [id, btn] of tabBtns) {
      const active = id === navState;
      btn.toggleClass("is-active", active);
      btn.setAttribute("aria-selected", String(active));
      // Roving tabindex: genau ein Tab ist per Tab-Taste erreichbar, innerhalb der Leiste
      // navigieren die Pfeiltasten (ARIA-Tabs-Muster).
      btn.setAttribute("tabindex", active ? "0" : "-1");
    }
  };

  panels.forEach((panel, i) => {
    const tabDomId = `${uid}-tab-${i}`;
    const panelDomId = `${uid}-panel-${i}`;

    const btn = tabsEl.createEl("button", {
      cls: "okit-hub-tab",
      // type="button": in einem <form>-Kontext wäre der Default "submit" — ein Tab-Wechsel
      // darf nichts abschicken.
      attr: { type: "button", role: "tab", id: tabDomId, "aria-controls": panelDomId, "data-tab": panel.id },
    });
    const ic = btn.createSpan({ cls: "okit-hub-tab-icon" });
    setIcon(ic, panel.icon);
    btn.createSpan({ cls: "okit-hub-tab-label", text: panel.label });
    btn.addEventListener("click", () => { ctrl.setTab(panel.id); });
    btn.addEventListener("keydown", (evt: KeyboardEvent) => {
      const last = order.length - 1;
      let target: number;
      if (evt.key === "ArrowRight") target = i === last ? 0 : i + 1;
      else if (evt.key === "ArrowLeft") target = i === 0 ? last : i - 1;
      else if (evt.key === "Home") target = 0;
      else if (evt.key === "End") target = last;
      else return;
      // Erst nach der Zuständigkeitsprüfung: sonst schluckte die Leiste fremde Tasten.
      evt.preventDefault();
      const next = order[target];
      if (!next) return;
      ctrl.setTab(next.id);
      next.btn.focus();
    });
    tabBtns.set(panel.id, btn);
    order.push({ id: panel.id, btn });

    const div = contentEl.createDiv({
      cls: "okit-hub-panel",
      attr: { role: "tabpanel", id: panelDomId, "aria-labelledby": tabDomId, "data-tab": panel.id },
    });
    panelDivs.set(panel.id, div);
    panel.mount(div);
  });

  const ctrl: HubController<Id> = {
    currentTab: () => navState,
    setTab(id: Id): void {
      if (id === navState) return;
      // Guard aus der finance-Fassung: ein Deep-Link oder persistierter Zustand kann einen
      // Tab nennen, dessen Panel nicht existiert. Ohne ihn versteckt applyVisibility ALLE
      // Panels und der Hub steht leer da.
      if (!panelDivs.has(id)) return;
      panels.find((p) => p.id === navState)?.onHide?.();
      navState = id;
      applyVisibility();
      void panels.find((p) => p.id === navState)?.onShow?.();
    },
    refreshActive(): void {
      void panels.find((p) => p.id === navState)?.onShow?.();
    },
    notifyFileOpen(path: string | null): void {
      for (const p of panels) p.onFileOpen?.(path);
    },
    destroy(): void {
      for (const p of panels) p.destroy();
    },
  };

  applyVisibility();
  void panels.find((p) => p.id === navState)?.onShow?.();   // Default-Panel initial onShow
  return ctrl;
}

/** CSS-Snippet der Hub-Tab-Leiste (nur Theme-Variablen) — der Consumer übernimmt es in
 *  seine `styles.css`. Das Kit injiziert bewusst kein CSS selbst (asset-/seiteneffektfrei),
 *  gleiches Muster wie `COLLAPSIBLE_CSS` und `ENDPOINT_LIST_CSS`.
 *
 *  **Eine Fassung, kein Varianten-Schalter.** Der Bestand kannte zwei Strategien —
 *  umbrechen (vault-rag, finance, vim-dojo) und schrumpfen (`flex: 1` ohne `wrap`,
 *  local-image-generator). Sie sind nicht kombinierbar (s. Falle 2 im Modulkopf), also muss
 *  eine gewinnen: Umbrechen. Unterhalb der Überlauf-Schwelle ist `wrap` unsichtbar — bei
 *  den zwei Tabs von local-image-generator entsteht nie eine zweite Zeile —, oberhalb
 *  rettet es einen sonst unerreichbaren Tab. Der Preis ist kosmetisch: Tabs sind
 *  label-proportional breit statt exakt gleich breit. */
export const HUB_CSS = `
/* Hub-Tab-Leiste (obsidian-kit: buildHubInto). Die vier nummerierten Zutaten gehören
   zusammen — jede einzeln ist wirkungslos, s. Modulkopf von src/obsidian/hub.ts. */
.okit-hub-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.okit-hub-tabs {
  display: flex;
  flex-wrap: wrap;                 /* (1) erlaubt die zweite Zeile */
  gap: var(--size-2-1);
  flex: 0 0 auto;
  border-bottom: 1px solid var(--background-modifier-border);
}
/* box-shadow: none nimmt dem nativen <button> nur seinen Ruhe-Schatten. Obsidians
   Fokusring bleibt: button:focus-visible { box-shadow: 0 0 0 3px … } hat mit (0,1,1) die
   höhere Spezifität als .okit-hub-tab (0,1,0) — geprüft in Obsidians app.css. */
.okit-hub-tab {
  display: flex;
  flex: 1 1 auto;                  /* (2) Basis = Inhaltsbreite, sonst bricht nichts um */
  min-width: 0;                    /* (3) hebt min-width:auto auf, sonst sprengt ein langes Label die Zeile */
  align-items: center;
  justify-content: center;
  gap: var(--size-4-1);
  padding: var(--size-2-3) var(--size-4-2);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  box-shadow: none;
  color: var(--text-muted);
  cursor: pointer;
}
.okit-hub-tab-label {              /* (4) ohne eigenes Label-Element kann nichts ellipsieren */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.okit-hub-tab-icon { display: inline-flex; flex: 0 0 auto; }
.okit-hub-tab:hover { color: var(--text-normal); background: var(--background-modifier-hover); }
.okit-hub-tab.is-active { color: var(--text-normal); border-bottom-color: var(--interactive-accent); }
.okit-hub-content { flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden; }
.okit-hub-panel { height: 100%; overflow: auto; }
.okit-hub-panel.is-hidden { display: none; }
`.trim();
