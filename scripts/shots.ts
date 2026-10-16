/**
 * Aufnahme-Treiber für die README-Bilder — fährt den Vertrag aus `docs/images/README.md`
 * gegen ein **laufendes** Obsidian, statt die Bilder von Hand zu klicken.
 *
 * Brücke, Aufnahme-Primitive und Fixture→Vault liegen zentral im Dach
 * (`obsidian-plugins/tools/obsidian-cdp/`); hier steht nur das Rezept — welches Bild was
 * zeigt. Denselben Import benutzt `scripts/gui-smoke.ts`.
 *
 * ## Ablauf (Zweitinstanz, eigener Port, Lock je Port — Dach-AGENTS.md § Staging-Vaults)
 *
 * Kein Quit und kein Neustart der regulaeren Instanz; `--port` ist Pflicht.
 *
 * ```bash
 * # STAGING_VAULTS_DIR muss gesetzt sein (steht in ~/.zshenv, kanonischer Ort:
 * # obsidian-plugins/AGENTS.md § Staging-Vaults). Hier KEIN Beispielwert — ein
 * # zweiter Ort in der Doku gabelt die Konvention, genau so entstand der Drift.
 * npm run build && npm run shots -- --setup
 *
 * UD=/tmp/obs-test-vault-crews; mkdir -p "$UD"
 * lsof -nP -iTCP:<port> -sTCP:LISTEN; pgrep -f "user-data-dir=$UD"      # beides leer
 * cp ~/Library/Application\ Support/obsidian/obsidian-*.asar "$UD"/
 * # $UD/obsidian.json: {"vaults":{"vc":{"path":"$STAGING_VAULTS_DIR/vault-crews","ts":1,"open":true}},"language":"en"}
 * python3 ~/.claude/hooks/obsidian-cdp-lock.py acquire --label vault-crews --intent "README-Bilder" --exclusive focus --port <port> --ttl 900
 * /Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir="$UD" --remote-debugging-port=<port> &
 * #   ... Aufnahme-Vault einmalig als vertrauenswürdig markieren (oder bereiteInstanzVor)
 *
 * npm run shots -- --port <port>
 * npm run shots -- --port <port> --only hero.png
 * npm run shots -- --list
 * python3 ~/.claude/hooks/obsidian-cdp-lock.py release
 * ```
 *
 * ## Was hier anders ist als in einem Rendering-Plugin
 *
 * Drei der fünf Bilder (`hero.png`, `history-undo.png`, `run-log.png`) zeigen einen **echten Lauf des Plugins**
 * gegen den zentralen LLM-Stub (`tools/obsidian-cdp/llm-stub.ts`), nicht gegen ein geladenes Modell: derselbe Strom bei
 * jeder Aufnahme, kein JIT-Laden, keine Abhängigkeit von LM Studio. Plugin, Orchestrator und Panel laufen echt; nur die
 * Antwort des Servers ist festgelegt. Ein nachgestellter Panel-Zustand würde den eigenen Eingriff dokumentieren statt das
 * Plugin.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { argv, cwd, env, exit } from "node:process";

import { startLlmStub, type LlmStub } from "../../tools/obsidian-cdp/llm-stub.js";

import {
  attachTo,
  Cdp,
  clearNotices,
  closeExtraLeaves,
  openExisting,
  pollUntil,
  requireUntil,
  requireVisible,
  setAppConfig,
  setPluginSetting,
} from "../../tools/obsidian-cdp/cdp.js";
import {
  boxOf,
  capture,
  setWindowSize,
  withMetrics,
  writeShot,
  type Rect,
  type ShotOptions,
} from "../../tools/obsidian-cdp/shot.js";
import { buildVault, stagingVaultDir } from "../../tools/obsidian-cdp/vault.js";

const PLUGIN_ID = "vault-crews";
const REPO_NAME = "vault-crews";
const VIEW_TYPE = "vault-crews-panel";
// `SHOTS_OUT` lenkt die Aufnahme in einen Arbeitsordner um (Bilder erst ansehen, dann nach docs/images kopieren).
const OUT_DIR = env.SHOTS_OUT ?? "docs/images";
const CAPTURE_WIDTH = 1200;
const THUMB_WIDTH = 380;
const PADDING = 10;
const FENSTER_BREITE = 1440;
const FENSTER_HOEHE = 900;
/** Muss im Endpunkt antworten und denken können — sonst bleibt der „Thinking"-Bereich
 *  leer und `hero.png` zeigt nicht das, was der Vertrag zusagt. */
const MODELL_STANDARD = "qwen/qwen3.6-35b-a3b";
/** Die Lauf-Bilder laufen gegen den zentralen LLM-Stub (`tools/obsidian-cdp/llm-stub.ts`), nicht gegen ein geladenes
 *  Modell: derselbe Strom bei jeder Aufnahme, kein JIT-Laden, keine Abhängigkeit von LM Studio. Inhalt: ein Denkblock, der
 *  zu den vier Fixture-Notizen passt, und ein Digest, den der Orchestrator als gültige `section.write`-Antwort annimmt
 *  (reiner Text, höchstens 700 Zeichen, drei Sätze). Takt und Länge sind so gewählt, dass das Bild MITTEN im Strom entsteht. */
const DENKEN = [
  "The four notes are about one thing: the move off the old scheduler.",
  "Migration plan says twelve jobs run on the new one since Monday, nothing failed, but the retry config was copied over verbatim.",
  "Vendor call warns that retry storms show up in the second week, and recommends two schedulers in parallel for a billing cycle.",
  "Retry behaviour is the concrete risk: five attempts, no jitter, and the new scheduler starts everything at the top of the hour.",
  "Storage costs are a side question: the old one wrote the export archive twice, and nobody knows if the new one does.",
  "Recurring topic first, then what changed, then what is open. Three sentences, plain prose.",
].join("\n");
const DIGEST = "The week is about the move off the old scheduler. "
  + "Twelve jobs have run on the new one since Monday without failures, but the retry settings still come from the old setup and the vendor expects retry storms in the second week. "
  + "Still open: the retry settings before the second batch moves, the window of the nightly export, and whether the duplicate export archive can be dropped.";
let STUB: LlmStub | null = null;
const endpunkt = (): { url: string; model: string }[] => [{ url: STUB ? STUB.urlV1 : "http://localhost:1234", model: MODELL }];

/** Wartet, bis ein laufender Lauf zu Ende ist (Ergebnis gesetzt, Ein-Lauf-Sperre frei). */
async function laufEnde(cdp: Cdp, timeoutMs = 90_000): Promise<boolean> {
  const fertig = await pollUntil<boolean>(cdp, `
    const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
    return p && p.runActive === false && Object.keys(p.lastRuns ?? {}).length > 0 ? true : null;
  `, timeoutMs, 500);
  return Boolean(fertig);
}

const TEAM_NOTIZ = "_crews/teams/reading-digest.md";
/** Ausgangsstand der Zielnotiz — identisch mit dem Fixture. Steht hier und nicht nur in
 *  der Datei, weil der Shot sie VOR dem Lauf zurueckschreiben muss. */
const ZIELNOTIZ = `# Weekly overview

A single note the crew writes into. Everything above and below the marked
section stays untouched — the crew replaces the block, not the file.

## Digest

<!-- vault-crews:start -->
_No digest yet. Run the crew from the panel._
<!-- vault-crews:end -->

## Notes of the week

- [[Migration plan]]
- [[Vendor call]]
- [[Storage costs]]
`;

interface Shot {
  name: string;
  klasse: "hero" | "feature" | "detail";
  /** Stellt den Zustand her und liefert den Ausschnitt (null = nicht aufnehmbar). */
  run(cdp: Cdp): Promise<Rect | null>;
}

// --- Helfer ------------------------------------------------------------------

/** Das Panel öffnen und auf seinen Wurzelknoten warten. */
async function panelOeffnen(cdp: Cdp, frisch = false): Promise<boolean> {
  // Das Panel baut seine Crew-Liste beim Öffnen auf und merkt NICHT, wenn eine
  // Crew-Datei von außen dazukommt — der Fixture-Vault ist genau dieser Fall. Ohne den
  // Neuaufbau steht dort „No crews yet", und der Fehlschlag liest sich wie ein kaputtes
  // Fixture. (Für den Nutzer heißt das: neue Crew-Datei → Panel einmal schließen.)
  if (frisch) {
    await cdp.evaluate(`
      for (const l of app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE)})) l.detach();
      await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
      await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    `);
  }
  await cdp.evaluate(`
    const vorhanden = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE)});
    if (vorhanden.length === 0) {
      const leaf = app.workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: ${JSON.stringify(VIEW_TYPE)}, active: true });
    }
    const blatt = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE)})[0];
    if (blatt) app.workspace.revealLeaf(blatt);
    await new Promise((r) => setTimeout(r, 500));
    return true;
  `);
  // Nur SICHTBARE Treffer: Obsidian hält den Inhalt geschlossener Blätter im DOM, und ein
  // 0×0-Element lässt jedes Warten in seinen Timeout laufen — die Meldung liest sich dann
  // wie „Panel öffnet nicht", während es daneben fertig steht.
  const da = await pollUntil<boolean>(cdp, `
    return [...document.querySelectorAll(".vault-crews-panel")]
      .some((e) => e.getBoundingClientRect().width > 1);
  `, 15_000, 300);
  return Boolean(da);
}

/** Ausschnitt des Panels — die Blatt-Kante außen, damit kein Fremdrand mitkommt. */
async function panelBox(cdp: Cdp): Promise<Rect | null> {
  // Obsidians Statusleiste schwebt über der rechten Sidebar und klebt sonst als fremdes
  // Symbol in jeder Panel-Aufnahme. Für die Dauer der Aufnahme ausblenden — kein Neuladen.
  await cdp.evaluate(`
    let s = document.getElementById("vc-shots-style");
    if (!s) {
      s = document.createElement("style");
      s.id = "vc-shots-style";
      s.textContent = ".status-bar { display: none !important; }";
      document.head.appendChild(s);
    }
    return true;
  `);
  // Die Kante des Blattes gibt die BREITE (sie liegt aussen), der Inhalt die HOEHE.
  // Nur den Container zu nehmen ergibt ein Bild, das zu zwei Dritteln leer ist — das
  // Panel ist so hoch wie das Fenster, der Inhalt endet nach der Ergebnis-Karte. Und ein
  // Seitenverhaeltnis von fast 3:1 reisst ausserdem die Grenze des Bild-Standards.
  const rahmen = await boxOf(cdp, ".workspace-split.mod-right-split", 0);
  if (!rahmen) return null;
  const unterkante = await cdp.evaluate<number | null>(`
    // Unterkante am INHALT des aktiven Hub-Panels, nicht am letzten Kind von .vault-crews-panel:
    // der Hub-Root füllt die Leaf-Höhe (flex: 1), das Panel wäre sonst immer fensterhoch.
    const inhalt = [...document.querySelectorAll(".vault-crews-panel .okit-hub-panel:not(.is-hidden) .vault-crews-content")]
      .filter((e) => e.getBoundingClientRect().width > 1)[0];
    if (!inhalt) return null;
    // Das LETZTE sichtbare Kind entscheidet, nicht die Hoehe des Containers.
    const kinder = [...inhalt.children].filter((e) => e.getBoundingClientRect().height > 0);
    const letztes = kinder[kinder.length - 1];
    return letztes ? letztes.getBoundingClientRect().bottom : inhalt.getBoundingClientRect().bottom;
  `);
  if (unterkante === null) return rahmen;
  const hoehe = Math.max(160, Math.min(rahmen.height, unterkante - rahmen.y + PADDING));
  return { ...rahmen, height: Math.round(hoehe) };
}

/** Wartet, bis der Lauf Text produziert — und gibt zurück, ob welcher kam.
 *  Auf ARBEIT warten, nicht auf eine Sekundenzahl: ein Bild „mitten im Strom" ist sonst
 *  entweder leer (Modell lädt noch per JIT) oder schon fertig. */
async function stromLaeuft(cdp: Cdp, mindestZeichen: number): Promise<boolean> {
  const da = await pollUntil<boolean>(cdp, `
    // Den Think-Bereich SOFORT aufklappen, nicht erst vor der Aufnahme: er ist ein
    // <details>, und zugeklappt hat sein Inhalt die Breite 0. Ein Sichtbarkeitsfilter
    // (der anderswo richtig ist) zaehlt ihn dann als nicht vorhanden — der Poll wartete
    // auf Text, der die ganze Zeit da war.
    const d = document.querySelector(".okit-stream-reasoning");
    if (d) d.open = true;
    // Die Klassen des Kit-Stream-Bereichs (buildStreamArea); die frueheren
    // .vault-crews-live-* und details.vault-crews-think gibt es seit 6173b64 nicht mehr.
    const teile = [...document.querySelectorAll(".okit-stream-tail, .okit-stream-reasoning pre")];
    const laenge = teile.reduce((n, e) => n + e.textContent.trim().length, 0);
    return laenge > ${mindestZeichen};
  `, 180_000, 400);
  return Boolean(da);
}

/** Den ersten Lauf der Fixture-Crew starten. Gibt false zurück, wenn kein Endpunkt
 *  antwortet — dann fehlen die Lauf-Bilder, und das ist eine Aussage, kein Fehler. */
async function laufStarten(cdp: Cdp): Promise<boolean> {
  // Der Fixture-Vault hat bewusst keinen Ordner `_crews/runs`: der erste Lauf legt ihn selbst an (Gegenprobe zum
  // Fix 407558c — vorher endete dieser Lauf mit einem io-Fehler, und das Rezept musste den Ordner vorab anlegen).
  const erreichbar = await cdp.evaluate<boolean>(`
    const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
    try {
      return await p.resolveActive() !== null;
    } catch { return false; }
  `);
  if (!erreichbar) {
    console.log("      · kein erreichbarer LLM-Endpunkt — Lauf-Bilder entfallen");
    return false;
  }
  const gestartet = await cdp.evaluate<boolean>(`
    const btn = [...document.querySelectorAll(".vault-crews-run")]
      .filter((e) => e.getBoundingClientRect().width > 1)[0];
    if (!btn) return false;
    btn.click();
    return true;
  `);
  if (!gestartet) console.log("      · kein Start-Knopf im Panel gefunden");
  return Boolean(gestartet);
}

// --- Rezept ------------------------------------------------------------------

const SHOTS: Shot[] = [
  {
    name: "hero.png",
    klasse: "hero",
    async run(cdp) {
      await setPluginSetting(cdp, PLUGIN_ID, "endpoints", endpunkt());
      // Nach dem Setzen den Weg gehen, den auch der Nutzer geht: die Einstellung allein
      // stellt den Zustand nicht her, das Plugin baut seinen Client beim Lauf neu.
      // Reste frueherer, abgebrochener Laeufe abraeumen: sonst begruesst das Bild den
      // Leser mit dem Wiederherstellungs-Dialog („Obsidian closed unexpectedly…"). Der
      // ist korrektes Verhalten — aber er zeigt den Zustand der Aufnahme-Maschine, nicht
      // das Produkt.
      await cdp.evaluate(`
        for (const m of document.querySelectorAll(".modal-container")) m.remove();
        const runs = app.vault.getAbstractFileByPath("_crews/runs");
        if (runs && runs.children) {
          for (const kind of [...runs.children]) await app.fileManager.trashFile(kind);
        }
        await new Promise((r) => setTimeout(r, 400));
        return true;
      `);
      // Die Zielnotiz auf den Fixture-Stand zuruecksetzen. Frueher Laeufe haben ihren
      // Digest hineingeschrieben — und ein Modell antwortet nicht immer in der Sprache,
      // in der das Bild entstehen soll. Jeder Shot stellt seine Voraussetzungen selbst her.
      await cdp.evaluate(`
        const f = app.vault.getAbstractFileByPath("Notes/Weekly overview.md");
        if (f) await app.vault.modify(f, ${JSON.stringify(ZIELNOTIZ)});
        await new Promise((r) => setTimeout(r, 300));
        return true;
      `);
      // Eine echte Notiz im Hauptbereich: ein leerer „New tab" daneben laesst das Bild
      // aussehen wie ein Screenshot ohne Kontext.
      await setAppConfig(cdp, "livePreview", true);
      await setAppConfig(cdp, "propertiesInDocument", "hidden");
      await openExisting(cdp, "Notes/Weekly overview.md", "preview");
      await closeExtraLeaves(cdp);
      if (!(await panelOeffnen(cdp, true))) return null;
      if (!(await laufStarten(cdp))) return null;
      // Genug Text, dass der Strom als Strom erkennbar ist — und der Thinking-Bereich
      // schon etwas enthält.
      if (!(await stromLaeuft(cdp, 180))) {
        console.log("      · kein Live-Text im Panel (Modell geladen? denkt es?)");
        return null;
      }
      await cdp.evaluate(`
        const d = document.querySelector(".okit-stream-reasoning");
        if (d) d.open = true;
        return true;
      `);
      // Das GANZE Fenster, nicht nur das Panel: ein Hero muss nach dem Bild-Standard
      // breiter als hoch sein (H/B <= 1.0), und ein Sidebar-Panel ist per Natur
      // hochformatig — als Panel-Ausschnitt kam 1.54 heraus. Das ganze Fenster ist
      // ausserdem die bessere Aussage: links die Notizen, rechts der laufende Lauf.
      return boxOf(cdp, ".workspace", 0);
    },
  },
  {
    name: "settings-endpoints.png",
    klasse: "feature",
    async run(cdp) {
      await setPluginSetting(cdp, PLUGIN_ID, "endpoints", [
        { url: "http://localhost:1234", model: MODELL },
      ]);
      const aktiv = await cdp.evaluate<string | null>(`
        app.setting.open();
        app.setting.openTabById(${JSON.stringify(PLUGIN_ID)});
        await new Promise((r) => setTimeout(r, 900));
        return app.setting.activeTab?.id ?? null;
      `);
      if (aktiv !== PLUGIN_ID) {
        console.log("      · Einstellungs-Tab nicht greifbar");
        return null;
      }
      // Ab Obsidian 1.13 sind die Einstellungen ein eigenes Fenster; dann steht das Modal
      // im Hauptfenster NICHT im DOM. Über die Sache wählen, nicht über den Titel — der
      // ist lokalisiert.
      const imHauptfenster = await cdp.evaluate<boolean>(
        `return Boolean(document.querySelector(".modal.mod-settings"));`,
      );
      const ui = imHauptfenster ? cdp : await attachTo("settings", PORT, REPO_NAME);
      if (!ui) {
        console.log("      · Einstellungs-Fenster nicht gefunden");
        return null;
      }
      // Die Zeile lädt ihre Modell-Liste beim Öffnen selbst; auf Ruhe warten statt auf
      // eine Sekundenzahl.
      // Ohne Ruhe wäre das Bild ein halb gezeichneter Tab: ein Timeout bricht ab (requireUntil), er nimmt nicht auf.
      await requireUntil(ui, `(() => {
        const box = document.querySelector(".okit-ep-row, .vertical-tab-content");
        return !!box && box.getBoundingClientRect().height > 100;
      })()`, "Einstellungs-Tab nicht zur Ruhe gekommen (Box-Höhe <= 100)");
      const box = await boxOf(ui, ".vertical-tab-content", 0);
      if (!box) return null;
      // Nur der obere Teil: die Verbindungs-Gruppe ist die Aussage, die restliche Seite
      // (Crews, Sicherheit, Erweitert) würde das Bild ins Hochformat ziehen.
      const png = await capture(ui, {
        x: box.x,
        y: box.y,
        width: box.width,
        height: Math.min(box.height, Math.round(box.width * 0.78)),
      });
      SETTINGS_PNG = png;
      if (ui !== cdp) ui.close();
      return { x: 0, y: 0, width: 0, height: 0 };   // Marker: Bild liegt schon vor
    },
  },
  {
    name: "crew-file.png",
    klasse: "feature",
    async run(cdp) {
      // Quelltext, nicht Live Preview: eine Crew IST eine Textdatei, und das Frontmatter
      // ist ihr Vertrag. In Live Preview zeigt Obsidian stattdessen die Properties-Tabelle
      // (im Aufnahme-Vault sogar ausgeblendet) — das Bild würde die Aussage verfehlen.
      await setAppConfig(cdp, "livePreview", false);
      // Und die Properties als ROHES YAML, nicht als Tabelle. Obsidian 1.13 rendert die
      // Tabelle auch im Quelltext-Modus; der Schalter dafuer heisst propertiesInDocument
      // und gehoert zur Laufzeit gesetzt, nicht in die Fixture-Datei (ein laufendes
      // Obsidian schreibt die Datei sonst zurueck).
      await setAppConfig(cdp, "propertiesInDocument", "source");
      await cdp.evaluate(`app.setting.close(); return true;`);
      if (!(await openExisting(cdp, TEAM_NOTIZ, "source"))) {
        console.log(`      · ${TEAM_NOTIZ} liess sich nicht oeffnen`);
        return null;
      }
      await closeExtraLeaves(cdp);
      const da = await pollUntil<boolean>(cdp, `
        const el = [...document.querySelectorAll(".markdown-source-view")]
          .filter((e) => e.getBoundingClientRect().width > 1)[0];
        return !!el && el.textContent.includes("crew-kind");
      `, 15_000, 300);
      if (!da) {
        console.log("      · Crew-Notiz zeigt kein Frontmatter");
        return null;
      }
      return boxOf(cdp, ".workspace-split.mod-root", 0);
    },
  },
  {
    name: "run-log.png",
    klasse: "feature",
    async run(cdp) {
      const log = await cdp.evaluate<string | null>(`
        const dateien = app.vault.getMarkdownFiles()
          .filter((f) => f.path.includes("/runs/") && f.name === "run.md")
          .sort((a, b) => b.stat.mtime - a.stat.mtime);
        return dateien.length ? dateien[0].path : null;
      `);
      if (!log) {
        console.log("      · kein run.md im Vault — erst hero.png aufnehmen (echter Lauf)");
        return null;
      }
      // Reste abgebrochener Laeufe wegraeumen, sonst steht der Wiederherstellungs-Dialog
      // mitten im Bild (korrektes Verhalten, aber nicht die Aussage dieses Bildes).
      await cdp.evaluate(`
        for (const m of document.querySelectorAll(".modal-container")) m.remove();
        return true;
      `);
      // Quelltext statt Lesemodus: die Aussage des Protokolls steht im Frontmatter
      // (status, writes, llm_calls, duration_s, model) — im Lesemodus rendert Obsidian es
      // als Properties-Tabelle, die dieser Vault ausblendet. Der Lesemodus zeigte
      // stattdessen den rohen Collector-Dump: formal ein Bild, inhaltlich nichts.
      await setAppConfig(cdp, "livePreview", false);
      await setAppConfig(cdp, "propertiesInDocument", "source");
      if (!(await openExisting(cdp, log, "source"))) return null;
      await closeExtraLeaves(cdp);
      // Die Aussage ist das ABGESCHLOSSENE Protokoll (status, writes, llm_calls, duration_s): `status:` steht schon im Frontmatter
      // eines laufenden Laufs (`status: running`, `llm_calls: 0`), `ended:` erst nach dem Ende. Gemessen 2026-10-14: im vollen
      // Lauf nimmt `hero.png` einen Lauf auf, der beim Bild `run-log.png` noch läuft, und die Bedingung `status:` wurde sofort wahr.
      // Ein Timeout bricht ab (requireUntil) statt ein unfertiges Bild zu nehmen.
      await requireUntil(cdp, `(() => {
        const el = [...document.querySelectorAll(".markdown-source-view")]
          .filter((e) => e.getBoundingClientRect().width > 1)[0];
        return !!el && el.textContent.includes("ended:");
      })()`, "run.md trägt kein ended: — der Lauf ist nicht zu Ende", 60_000, 500);
      const rahmen = await boxOf(cdp, ".workspace-split.mod-root", 0);
      if (!rahmen) return null;
      // Auf das Seitenverhaeltnis der Klasse begrenzen (feature: H/B <= 1.6). Die Kante
      // gehoert ins Rezept, nicht in einen Nachschnitt — sonst ist das Rezept nicht mehr
      // die einzige Quelle des Bildes.
      return { ...rahmen, height: Math.min(rahmen.height, Math.round(rahmen.width * 1.5)) };
    },
  },
  {
    name: "history-undo.png",
    klasse: "feature",
    async run(cdp) {
      await setPluginSetting(cdp, PLUGIN_ID, "endpoints", endpunkt());
      // Immer ein eigener, frischer Lauf: ein Lauf aus dem Hero-Bild wurde beim Beenden des Stubs mitten im Strom
      // abgebrochen und stünde als „Failed" im Verlauf. Ohne geschriebene Datei gäbe es keinen Rückgängig-Knopf.
      await cdp.evaluate(`
        const f = app.vault.getAbstractFileByPath("Notes/Weekly overview.md");
        if (f) await app.vault.modify(f, ${JSON.stringify(ZIELNOTIZ)});
        const runs = app.vault.getAbstractFileByPath("_crews/runs");
        if (runs && runs.children) for (const kind of [...runs.children]) await app.fileManager.trashFile(kind);
        return true;
      `);
      if (!(await panelOeffnen(cdp, true))) return null;
      if (!(await laufStarten(cdp))) return null;
      if (!(await laufEnde(cdp))) {
        console.log("      · der Lauf endete nicht in 90 s");
        return null;
      }
      const status = await cdp.evaluate<string>(`
        const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        return Object.values(p.lastRuns ?? {}).map((r) => r.status).join(",");
      `);
      if (status !== "ok") {
        console.log(`      · der Lauf endete mit „${status}" statt ok — Verlauf-Bild entfällt`);
        return null;
      }
      // Die Toasts des Laufs („run completed", Hinweise zum Modell) gehören nicht ins Bild: sie liegen über dem Panel.
      await clearNotices(cdp);
      await new Promise((r) => setTimeout(r, 600));
      if (!(await panelOeffnen(cdp))) return null;
      await clearNotices(cdp);
      const gewechselt = await cdp.evaluate<boolean>(`
        const tabs = [...document.querySelectorAll(".vault-crews-panel .okit-hub-tab")]
          .filter((e) => e.getBoundingClientRect().width > 1);
        if (tabs.length < 2) return false;
        tabs[tabs.length - 1].click();
        await new Promise((r) => setTimeout(r, 500));
        return true;
      `);
      if (!gewechselt) {
        console.log("      · Verlauf-Tab nicht gefunden");
        return null;
      }
      return panelBox(cdp);
    },
  },
];

/** Bild, das ein Shot bereits selbst aufgenommen hat (Einstellungen liegen in einem
 *  eigenen Fenster — dort kann die Hauptschleife nicht aufnehmen). */
let SETTINGS_PNG: Buffer | null = null;

// --- Rahmen ------------------------------------------------------------------

const args = argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value ?? fallback;
};
const PORT = Number(argOf("port", ""));
/** Welches Modell die Lauf-Bilder benutzen. Ueberschreibbar, weil nicht jede Maschine
 *  jedes Modell laedt: LM Studios Guardrail lehnt einen JIT-Load ab, wenn der Speicher
 *  knapp ist — und ein Bild, das an einem nicht ladbaren Modell scheitert, sagt nichts
 *  ueber das Plugin. `--modell <id>` waehlt eines, das da ist. */
const MODELL = argOf("modell", MODELL_STANDARD);
const ONLY = args.includes("--only") ? argOf("only", "") : undefined;
const SETUP = args.includes("--setup");
const LIST = args.includes("--list");

if (LIST) {
  for (const s of SHOTS) console.log(`${s.name.padEnd(26)} ${s.klasse}`);
  exit(0);
}

if (SETUP) {
  const vault = stagingVaultDir(REPO_NAME);
  for (const zeile of buildVault({
    repoRoot: cwd(),
    vaultDir: vault,
    fixtureDir: join(cwd(), "docs/images/fixture"),
    pluginId: PLUGIN_ID,
  })) {
    console.log(`  ${zeile}`);
  }
  console.log(`\nVault: ${vault}\nJetzt Obsidian neu starten und diesen Vault oeffnen.`);
  exit(0);
}

const OPTS: ShotOptions = { outDir: OUT_DIR, captureWidth: CAPTURE_WIDTH, thumbWidth: THUMB_WIDTH };

async function main(): Promise<void> {
  if (!Number.isInteger(PORT) || PORT <= 0) {
    console.error("--port <port> ist Pflicht (Zweitinstanz, siehe Kopf dieser Datei); kein Standardport.");
    exit(2);
  }
  const cdp = await attachTo("workspace", PORT, argOf("vault", ""));
  if (!cdp) {
    console.error(`Kein Obsidian-Fenster am Port ${PORT}.`);
    exit(1);
  }
  // Das Fenster selbst nach vorn holen, statt es vom Aufrufer zu verlangen: `requireVisible` zielt
  // auf das VERBUNDENE Fenster. Ein `osascript … activate` holte stattdessen die reguelaere Instanz
  // nach vorn (Befund kl-w19).
  await requireVisible(cdp);

  const sprache = await cdp.evaluate<string>(
    `return document.documentElement.lang || (window.localStorage && localStorage.getItem("language")) || "en";`,
  );
  if (!sprache.startsWith("en")) {
    console.error(
      `Aufnahmesprache ist „${sprache}", erwartet Englisch — README.md ist die kanonische Fassung.\n`
      + `  Sprache in den Einstellungen auf English stellen und Obsidian neu starten.`,
    );
    cdp.close();
    exit(1);
  }

  await setWindowSize(cdp, FENSTER_BREITE, FENSTER_HOEHE);

  // Der Stub läuft nur für die Lauf-Bilder; Einstellungs- und Datei-Bilder brauchen ihn nicht.
  const braucht = (n: string): boolean => n === "hero.png" || n === "history-undo.png" || n === "run-log.png";
  if ((ONLY ? [ONLY] : SHOTS.map((x) => x.name)).some(braucht)) {
    STUB = await startLlmStub({
      models: [MODELL], takt: 90, laenge: 6, nachlaufMs: 400,
      standard: { reasoning: DENKEN, text: DIGEST },
    });
    console.log(`  LLM-Stub: ${STUB.urlV1} (Modell ${MODELL})`);
  }

  const geplant = ONLY ? SHOTS.filter((s) => s.name === ONLY) : SHOTS;
  if (geplant.length === 0) {
    console.error(`Kein Bild namens „${ONLY}" im Vertrag.`);
    cdp.close();
    exit(1);
  }

  const fehlend: string[] = [];
  for (const shot of geplant) {
    console.log(`\n▶ ${shot.name}`);
    try {
      const box = await shot.run(cdp);
      if (!box) {
        fehlend.push(shot.name);
        continue;
      }
      const png = SETTINGS_PNG ?? await capture(cdp, box.width > 0 ? box : undefined);
      SETTINGS_PNG = null;
      const pfad = await writeShot(cdp, shot.name, png, {
        ...OPTS,
        thumb: shot.klasse === "detail",
      });
      console.log(`  → ${pfad}`);
    } catch (e) {
      console.log(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
      fehlend.push(shot.name);
    }
  }

  if (fehlend.length > 0) {
    console.log(`\nNicht aufgenommen: ${fehlend.join(", ")}`);
    console.log("Fehlt ein Bild dauerhaft, gehoert es MIT BEGRUENDUNG in den Vertrag —");
    console.log("nicht stillschweigend gestrichen.");
  }
  await STUB?.stop();
  cdp.close();
}

await main();
