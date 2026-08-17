/**
 * GUI-Smoke-Treiber — fährt die mechanisch entscheidbaren Punkte aus `docs/SMOKE.md`
 * gegen ein **laufendes** Obsidian statt von Hand (CORE-TEST-02 b).
 *
 * Warum gerade jetzt getrackt: 0.9.0 baut den Einstellungs-Tab komplett um (Endpunkte
 * tragen Schlüssel und Modell, der Zeilen-Editor kommt aus dem Kit) und **migriert dabei
 * die `data.json` des Nutzers**. Beides ist gegen Mocks geprüft — und genau das ist der
 * Punkt: der Obsidian-Mock beweist DOM-Struktur, nie Sichtbarkeit, und eine Migration
 * beweist er schon gar nicht. Der teuerste Fehler dieses Releases wäre eine Einstellung,
 * die beim ersten Start still verschwindet.
 *
 * Der Treiber kommt **ohne Crew-Lauf aus**: er misst die Einstellungen und die Migration,
 * nicht das Modell. Ein Smoke, der an einem LLM hängt, misst das LLM mit.
 *
 * ## Voraussetzung
 *
 * ```bash
 * osascript -e 'quit app "Obsidian"'
 * open -a Obsidian --args --remote-debugging-port=9222
 * OBSIDIAN_PLUGIN_DIR="<vault>/.obsidian/plugins/vault-crews" npm run deploy
 * ```
 *
 * Dann:
 *
 * ```bash
 * npm run smoke:gui -- --vault 10_Pallas
 * npm run smoke:gui -- --port 9222 --keep
 * ```
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { attachTo, Cdp, requireVisible } from "../../tools/obsidian-cdp/cdp.js";

const PLUGIN_ID = "vault-crews";

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value ?? fallback;
};
const PORT = Number(argOf("port", "9222"));
const VAULT = args.includes("--vault") ? argOf("vault", "") : undefined;
const KEEP = args.includes("--keep");

// --- Prüfpunkte --------------------------------------------------------------

interface Check {
  name: string;
  passed: boolean;
  detail: string;
  skipped?: boolean;
}
const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "✓" : "✗"} ${name} — ${detail}`);
}

function skipped(name: string, reason: string): void {
  checks.push({ name, passed: true, skipped: true, detail: `übersprungen: ${reason}` });
  console.log(`· ${name} — übersprungen: ${reason}`);
}

/** Verletzte Umgebungsbedingung — KEIN Befund am Prüfling.
 *
 *  Der Unterschied ist die halbe Regel (CORE-TEST-02 g): „antwortet nicht" ist die fehlende
 *  Umgebung und bricht mit Ansage ab; „antwortet falsch" ist ein Befund und bleibt rot. Wer
 *  beides zusammenwirft, verbucht den gesuchten Defekt als Nichtmessung — dann läuft die
 *  Gegenprobe durch, ohne rot zu werden. */
class PreconditionError extends Error {}

// --- Helfer ------------------------------------------------------------------

/** Plugin neu laden, ohne Obsidian anzufassen — das ist der Pfad, auf dem `loadSettings`
 *  und damit die Migration läuft. */
async function pluginNeuLaden(cdp: Cdp): Promise<void> {
  await cdp.evaluate(`
    await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
    await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
    await new Promise((r) => setTimeout(r, 900));
    return true;
  `);
}

/** Den Einstellungs-Tab dieses Plugins öffnen und zeichnen lassen.
 *
 *  Ab Obsidian 1.13 sind die Einstellungen ein eigenes Fenster: `openTabById` gelingt,
 *  `app.setting.activeTab.id` stimmt — und `.modal.mod-settings` im Workspace-Fenster
 *  bleibt trotzdem null. Deshalb gibt diese Funktion zurück, WO gemessen werden muss,
 *  statt es zu raten. */
async function einstellungenOeffnen(cdp: Cdp): Promise<Cdp | null> {
  const aktiv = await cdp.evaluate<string | null>(`
    app.setting.open();
    app.setting.openTabById(${JSON.stringify(PLUGIN_ID)});
    await new Promise((r) => setTimeout(r, 700));
    return app.setting.activeTab?.id ?? null;
  `);
  if (aktiv !== PLUGIN_ID) return null;

  const imHauptfenster = await cdp.evaluate<boolean>(
    `return Boolean(document.querySelector(".modal.mod-settings"));`,
  );
  if (imHauptfenster) return cdp;
  return attachTo("settings", PORT);
}

/** Innentext des Einstellungs-Containers. `null`, wenn es ihn nicht gibt — die
 *  Unterscheidung ist load-bearing: ein Vergleich gegen einen nicht existierenden
 *  Container wird sonst ausgerechnet im Defektfall grün. */
async function tabText(ui: Cdp): Promise<string | null> {
  return ui.evaluate<string | null>(`
    const el = document.querySelector(".modal.mod-settings .vertical-tab-content")
      || document.querySelector(".vertical-tab-content-container .vertical-tab-content")
      || document.querySelector(".vertical-tab-content");
    return el ? el.innerText : null;
  `);
}

// --- Abschnitt: Migration der data.json ---------------------------------------

/** Der Punkt, an dem dieses Release still Schaden anrichten könnte: die alte `data.json`
 *  trägt eine Liste roher URL-Strings plus EIN globales `defaultModel`. Kommt daraus
 *  nicht genau ein Eintrag MIT diesem Modell heraus, hat der Nutzer nach dem Update ein
 *  Plugin ohne Modell — und merkt es erst, wenn eine Crew nicht mehr läuft.
 *
 *  Gemessen wird über den echten Ladepfad (`disablePlugin`/`enablePlugin`), nicht durch
 *  Aufruf der Migrationsfunktion: die ist unit-getestet, der Ladepfad war es nie. */
async function abschnittMigration(cdp: Cdp, dataPfad: string): Promise<void> {
  const alt = {
    endpoints: ["http://localhost:1234"],
    deniedEndpoints: ["http://localhost:8080"],
    defaultModel: "qwen/qwen3.6-35b-a3b",
    crewRoot: "_vault-crews-smoke/_crews",
    maxWrites: 5,
  };
  writeFileSync(dataPfad, JSON.stringify(alt, null, 2));
  await pluginNeuLaden(cdp);

  const nachher = await cdp.evaluate<{ endpoints: unknown; defaultModel: unknown; crewRoot: string }>(`
    const s = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].settings;
    return { endpoints: s.endpoints, defaultModel: s.defaultModel, crewRoot: s.crewRoot };
  `);
  const eps = nachher.endpoints as { url?: string; model?: string }[] | undefined;
  const einEintrag = Array.isArray(eps) && eps.length === 1;
  record(
    "Alte Endpunkt-Liste wird zu genau einem Eintrag",
    einEintrag && eps?.[0]?.url === "http://localhost:1234",
    JSON.stringify(nachher.endpoints),
  );
  record(
    "Das alte globale Modell landet in der Zeile und geht nicht verloren",
    eps?.[0]?.model === alt.defaultModel,
    `model: ${JSON.stringify(eps?.[0]?.model)}`,
  );
  record(
    "Das globale Modellfeld existiert nicht mehr",
    nachher.defaultModel === undefined,
    `defaultModel: ${JSON.stringify(nachher.defaultModel)}`,
  );
  record(
    "Die übrigen Einstellungen überstehen die Migration",
    nachher.crewRoot === alt.crewRoot,
    `crewRoot: ${JSON.stringify(nachher.crewRoot)}`,
  );

  // Falle 5 des Kit-Rollouts: ein von Hand kaputt editiertes Feld reicht bis `.map` im
  // Kit durch und reisst den GANZEN Plugin-Load mit ("failed to load plugin"). Der Guard
  // sitzt am Aufrufer-Rand — hier wird geprüft, dass er dort auch wirkt.
  writeFileSync(dataPfad, JSON.stringify({ ...alt, endpoints: "http://kaputt" }, null, 2));
  await pluginNeuLaden(cdp);
  const nachKaputt = await cdp.evaluate<{ geladen: boolean; istListe: boolean; wert: string }>(`
    const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
    const eps = p ? p.settings.endpoints : undefined;
    return {
      geladen: Boolean(p),
      istListe: Array.isArray(eps) && eps.length > 0 && typeof eps[0] === "object",
      wert: JSON.stringify(eps),
    };
  `);
  // `Array.isArray` statt `.length`: der erste Entwurf fragte nur nach der Laenge — und ein
  // String hat eine. Der Punkt blieb deshalb in der Gegenprobe gruen, obwohl `endpoints`
  // danach der rohe String "http://kaputt" war. Genau der Zustand, gegen den der Guard
  // steht: das Plugin laedt scheinbar, und der erste Lauf stirbt spaeter an `.filter`.
  record(
    "Ein kaputtes data.json-Feld reisst den Plugin-Start nicht mit",
    nachKaputt.geladen && nachKaputt.istListe,
    nachKaputt.geladen
      ? `geladen, endpoints = ${nachKaputt.wert}`
      : "Plugin NICHT geladen",
  );
}

// --- Abschnitt: Einstellungs-Tab ----------------------------------------------

/** Was 409 grüne Tests nicht sehen: ob der Kit-Zeilen-Editor im echten Obsidian
 *  überhaupt etwas zeichnet. Gemessen wird der Effekt (Felder im DOM, Text auf dem
 *  Schirm), nicht die Ursache (Funktion gerufen?). */
async function abschnittEinstellungen(cdp: Cdp): Promise<void> {
  const ui = await einstellungenOeffnen(cdp);
  if (!ui) {
    skipped("Einstellungs-Tab öffnet", "Tab nicht greifbar");
    return;
  }
  record("Einstellungs-Tab öffnet", true, "Tab aktiv");

  const felder = await ui.evaluate<{ url: number; key: number; modell: number; textarea: number } | null>(`
    const wurzel = document.querySelector(".modal.mod-settings .vertical-tab-content")
      || document.querySelector(".vertical-tab-content");
    if (!wurzel) return null;
    // Das Schlüsselfeld ist bewusst type="password" (maskiert gegen Schultergucken und
    // gegen Screenshots) — ein Selektor nur auf Text-Inputs findet es nicht und meldet
    // im ersten Lauf faelschlich "kein Schluesselfeld".
    const inputs = [...wurzel.querySelectorAll("input[type=text], input[type=password], input:not([type])")];
    const label = (el) => (el.getAttribute("aria-label") || el.placeholder || "").toLowerCase();
    return {
      url: inputs.filter((el) => /endpunkt|endpoint|url/.test(label(el))).length,
      key: inputs.filter((el) => el.type === "password"
        || /schlüssel|schluessel|api key|api-key/.test(label(el))).length,
      modell: inputs.filter((el) => /modell|model/.test(label(el))).length
        + wurzel.querySelectorAll("select").length,
      textarea: wurzel.querySelectorAll("textarea").length,
    };
  `);
  if (!felder) {
    skipped("Endpunkt-Zeile zeichnet URL, Schlüssel und Modell", "Tab-Inhalt nicht gefunden");
    return;
  }
  record(
    "Endpunkt-Zeile zeichnet ein URL-Feld",
    felder.url > 0,
    `${felder.url} URL-Feld(er)`,
  );
  // Das Feld, das es vor 0.9.0 gar nicht gab — und der eigentliche Anlass des Umbaus.
  record(
    "Endpunkt-Zeile zeichnet ein Schlüsselfeld",
    felder.key > 0,
    `${felder.key} Schlüsselfeld(er)`,
  );
  record(
    "Endpunkt-Zeile zeichnet ein Modellfeld",
    felder.modell > 0,
    `${felder.modell} Modellfeld(er)/Auswahl(en)`,
  );
  // Die Sperrliste ist seit 0.9.0 eine Textarea statt eines Zeilen-Editors.
  record(
    "Die Sperrliste ist ein mehrzeiliges Textfeld",
    felder.textarea > 0,
    `${felder.textarea} Textarea(s)`,
  );

  const text = await tabText(ui);
  if (text === null) {
    skipped("Kein roher Übersetzungs-Schlüssel im Tab", "Tab-Inhalt nicht gefunden");
  } else {
    // Ein fehlender i18n-Schlüssel ist in diesem Plugin NICHT leer: `t()` fällt auf den
    // Schlüssel zurück, und `settings.connection.role.active` sieht im Tab aus wie Text.
    const roh = [...new Set(text.match(/\bsettings\.[a-zA-Z][a-zA-Z.]+/g) ?? [])];
    record(
      "Kein roher Übersetzungs-Schlüssel im Tab",
      roh.length === 0,
      roh.length === 0 ? "keine gefunden" : roh.join(", "),
    );
    // Das gestrichene globale Feld darf nicht als Leiche zurückbleiben.
    record(
      "Kein globales Feld „Standardmodell\" mehr",
      !/standardmodell|default model/i.test(text),
      /standardmodell|default model/i.test(text) ? "steht noch im Tab" : "nicht mehr vorhanden",
    );
  }

  if (ui !== cdp) ui.close();
}

/** Trägt man einen Schlüssel ein, muss die Oberfläche sagen, dass Anfragen dieses
 *  Endpunkts den Rechner verlassen. Das ist keine Kosmetik: es ist die einzige Stelle,
 *  an der ein unbeaufsichtigt laufendes Plugin den Nutzer darüber informiert. */
async function abschnittDrittanbieter(cdp: Cdp): Promise<void> {
  const vorher = await cdp.evaluate<unknown>(
    `return app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].settings.endpoints;`,
  );
  await cdp.evaluate(`
    const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
    p.settings.endpoints = [{ url: "http://localhost:1234", apiKey: "smoke-test-key-123", model: "" }];
    await p.saveSettings();
    app.setting.open();
    app.setting.openTabById(${JSON.stringify(PLUGIN_ID)});
    await new Promise((r) => setTimeout(r, 700));
    return true;
  `);
  const ui = await einstellungenOeffnen(cdp);
  // Der Hinweis ist ein ICON mit Tooltip, kein Fliesstext — im innerText steht er nicht.
  // Der erste Lauf suchte im Text und meldete ihn deshalb faelschlich als fehlend.
  const hinweis = ui
    ? await ui.evaluate<{ da: boolean; label: string } | null>(`
        const wurzel = document.querySelector(".modal.mod-settings .vertical-tab-content")
          || document.querySelector(".vertical-tab-content");
        if (!wurzel) return null;
        const el = wurzel.querySelector(".okit-ep-thirdparty");
        return { da: Boolean(el), label: el ? (el.getAttribute("aria-label") || "") : "" };
      `)
    : null;
  if (hinweis === null) {
    skipped("Schlüssel führt zum Drittanbieter-Hinweis", "Tab-Inhalt nicht gefunden");
  } else {
    record(
      "Schlüssel führt zum Drittanbieter-Hinweis",
      hinweis.da,
      hinweis.da
        ? `Hinweis sichtbar: „${hinweis.label}"`
        : "Hinweis FEHLT, obwohl ein Schlüssel gesetzt ist",
    );
  }
  if (ui && ui !== cdp) ui.close();
  await cdp.evaluate(`
    const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
    p.settings.endpoints = ${JSON.stringify(vorher)};
    await p.saveSettings();
    return true;
  `);
}

// --- Hauptlauf ---------------------------------------------------------------

// --- Abschnitt: deklarative Settings-API --------------------------------------

/**
 * Die Umstellung auf `getSettingDefinitions()` (Obsidian ≥ 1.13) verlegt das Zeichnen der
 * Einstellungen vom eigenen Code zum Host. Was danach in der Oberfläche steht, kann kein
 * vitest-Fall mehr zeigen — und die Fallstricke der Umstellung sind allesamt **stille**:
 * eine Zeile, die per `visible: false` versteckt statt weggelassen wird (der native
 * Renderer wertet das an Gruppen-Items nicht aus, sie bleibt stehen), eine Zeile ohne
 * eigenen Renderer (die überspringt er stillschweigend), und ein Fallback-Pfad, der
 * niemandem auffällt, weil der Host ihn ab 1.13 nie mehr aufruft.
 *
 * Beides zusammen ist der Grund, aus dem der Umbau überhaupt lohnt: ohne die Methode
 * erscheint KEINE Einstellung dieses Plugins in Obsidians Einstellungs-Suche.
 *
 * Unter 1.12 gibt es den nativen Pfad nicht; dort wird der Abschnitt übersprungen statt rot.
 */
async function abschnittDeklarativ(cdp: Cdp): Promise<void> {
  console.log("\n── Deklarative Settings-API ──");

  const ui = await einstellungenOeffnen(cdp);
  if (!ui) {
    skipped("Deklarative API", "Einstellungen-Tab nicht zu oeffnen");
    return;
  }

  // Die Definitionen leben im HAUPTfenster: das ausgelagerte Einstellungen-Fenster hat ab
  // 1.13 einen eigenen JS-Kontext und kennt kein `app` (Fund yijing-oracle 2026-08-16).
  const defs = await cdp.evaluate<{
    hatUpdate: boolean;
    gruppen: number;
    leereGruppen: number;
    uebernommen: number | null;
    mitVisible: number;
    stumm: number;
    suchbegriff: string | null;
    pluginName: string;
  } | null>(`
    const tab = app.setting.activeTab;
    if (!tab || typeof tab.getSettingDefinitions !== "function") return null;
    const d = tab.getSettingDefinitions();
    const flach = (items) => items.flatMap((i) => [i, ...flach(i.items || [])]);
    const alle = flach(d);
    return {
      hatUpdate: typeof tab.update === "function",
      gruppen: d.length,
      leereGruppen: d.filter((g) => !(g.items || []).length).length,
      uebernommen: Array.isArray(tab.settingItems) ? tab.settingItems.length : null,
      mitVisible: alle.filter((i) => i.visible !== undefined).length,
      stumm: alle.filter((i) => !i.heading && !i.items && !i.control && !i.render).length,
      suchbegriff: (d[1] && d[1].items && d[1].items[0] && d[1].items[0].name) || null,
      pluginName: app.plugins.manifests[${JSON.stringify(PLUGIN_ID)}].name,
    };
  `);

  if (!defs) {
    record("Deklarative API vorhanden", false, "getSettingDefinitions() fehlt am aktiven Tab");
    await cdp.evaluate(`app.setting.close(); return true;`).catch(() => undefined);
    return;
  }
  if (!defs.hatUpdate) {
    skipped("Deklarative API", "Obsidian ohne native 1.13-Settings-API (nur Fallback-Pfad)");
    await cdp.evaluate(`app.setting.close(); return true;`).catch(() => undefined);
    return;
  }

  record(
    "Tab liefert Definitionen und der Host uebernimmt sie",
    defs.gruppen > 0 && defs.leereGruppen === 0 && defs.uebernommen === defs.gruppen,
    `${defs.gruppen} Gruppen, ${defs.leereGruppen} leer, vom Host uebernommen: ${String(defs.uebernommen)}`,
  );

  // Die beiden Fallstricke aus REGISTRY.md, gemessen statt geglaubt: bedingte Zeilen
  // gehoeren weggelassen (`visible` wirkt nicht), und jede Zeile braucht einen Regler
  // oder einen eigenen Renderer (sonst ueberspringt der native Renderer sie).
  record(
    "keine versteckten und keine stummen Zeilen",
    defs.mitVisible === 0 && defs.stumm === 0,
    `${defs.mitVisible} Zeilen mit visible, ${defs.stumm} ohne Regler/Renderer`,
  );

  // Der eigentliche Gewinn. Der Suchbegriff kommt aus der eigenen Definition, nicht aus
  // einer festen Zeichenkette — sonst misst der Treiber die UI-Sprache.
  if (defs.suchbegriff) {
    const treffer = await sucheInEinstellungen(ui, defs.suchbegriff, defs.pluginName);
    const nichts = await sucheInEinstellungen(ui, "zzqqxx-gibtesnicht", defs.pluginName);
    record(
      "Einstellungen erscheinen in Obsidians Einstellungs-Suche",
      treffer > 0 && nichts === 0,
      `„${defs.suchbegriff}" → ${treffer} Treffer unter „${defs.pluginName}", Unsinn → ${nichts}`,
    );
  } else {
    skipped("Einstellungs-Suche", "kein Suchbegriff aus den Definitionen ableitbar");
  }

  // Der andere Pfad. Unter 1.13 ruft der Host `display()` nie — der Fallback fuer aeltere
  // Obsidian-Versionen liefe also ungeprueft mit. Ein direkter Aufruf zeichnet ihn in
  // denselben Container: dieselben Zeilen, mit der klassischen Setting-API gebaut. Das
  // ersetzt keine Messung auf einem echten 1.12, deckt aber den teuren Fehler ab (der
  // Walker zeichnet die Struktur gar nicht oder nur halb).
  const nativZeilen = await zeilenZahl(ui);
  await cdp.evaluate(`
    app.setting.activeTab.display();
    await new Promise((r) => setTimeout(r, 700));
    return true;
  `);
  const fallbackZeilen = await zeilenZahl(ui);
  record(
    "Fallback-Pfad (< 1.13) zeichnet dieselbe Struktur",
    fallbackZeilen === nativZeilen && nativZeilen > 0,
    `nativ ${nativZeilen} Zeilen, display()-Fallback ${fallbackZeilen}`,
  );

  await cdp.evaluate(`app.setting.close(); return true;`).catch(() => undefined);
}

/** Gerenderte Setting-Zeilen in der Einstellungen-Oberflaeche. */
async function zeilenZahl(ui: Cdp): Promise<number> {
  return ui.evaluate<number>(`
    const wurzel = document.querySelector(".modal.mod-settings .vertical-tab-content")
      || document.querySelector(".vertical-tab-content-container .vertical-tab-content")
      || document.querySelector(".vertical-tab-content");
    return wurzel ? wurzel.querySelectorAll(".setting-item").length : -1;
  `);
}

/** Tippt in Obsidians Einstellungs-Suche und zaehlt die Treffer, die UNSEREM Plugin
 *  zugeordnet sind — die Ergebnisse stehen je Tab in einer eigenen Gruppe. */
async function sucheInEinstellungen(ui: Cdp, begriff: string, pluginName: string): Promise<number> {
  return ui.evaluate<number>(`
    const feld = document.querySelector('input[type="search"]');
    if (!feld) return -1;
    feld.value = ${JSON.stringify(begriff)};
    feld.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const gruppe = [...document.querySelectorAll(".setting-search-result-group")].find(
      (g) => g.querySelector(".setting-search-result-tab-label")?.textContent?.trim() === ${JSON.stringify(pluginName)},
    );
    return gruppe ? gruppe.querySelectorAll(".setting-search-result-item").length : 0;
  `);
}

async function main(): Promise<void> {
  const cdp = await attachTo("workspace", PORT, VAULT);
  if (!cdp) {
    console.error(
      `Kein Obsidian-Fenster${VAULT ? ` fuer Vault „${VAULT}"` : ""} am Port ${PORT}.\n`
      + `Starten mit: open -a Obsidian --args --remote-debugging-port=${PORT}`,
    );
    process.exitCode = 1;
    return;
  }

  const aktiv = await cdp.evaluate<boolean>(
    `return Boolean(app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]);`,
  );
  if (!aktiv) {
    console.error(`Plugin „${PLUGIN_ID}" ist im geoeffneten Vault nicht aktiv.`);
    cdp.close();
    process.exitCode = 1;
    return;
  }

  // Die Prüfung liegt in der zentralen Brücke — sie gilt für jeden Treiber, der DOM misst.
  // Die Verbindung MUSS dabei geschlossen werden: ein offener WebSocket hält den
  // Node-Event-Loop am Leben, und der Treiber gäbe seine Abbruch-Meldung aus und liefe
  // dann ewig weiter — nach außen ununterscheidbar von einem hängenden Lauf.
  try {
    await requireVisible(cdp);
  } catch (e) {
    cdp.close();
    throw new PreconditionError(e instanceof Error ? e.message : String(e));
  }

  const basis = await cdp.evaluate<string>(`return app.vault.adapter.basePath;`);
  const dataPfad = `${basis}/${await cdp.evaluate<string>("return app.vault.configDir;")}/plugins/${PLUGIN_ID}/data.json`;
  const rettung = `${dataPfad}.smoke-rettung`;

  // Der Vorwert wird VOR dem try gelesen und liegt zusaetzlich als Datei neben dem
  // Original: das `finally` laeuft bei Ctrl-C oder einem Absturz des Node-Prozesses
  // nicht mehr — und was dann im produktiven Vault stuende, waere eine Testfixtur.
  const vorwert = existsSync(dataPfad) ? readFileSync(dataPfad) : null;
  if (vorwert) copyFileSync(dataPfad, rettung);

  try {
    if (vorwert) {
      await abschnittMigration(cdp, dataPfad);
    } else {
      skipped("Migration der data.json", "keine data.json vorhanden");
    }

    // Ab hier gegen den ECHTEN Stand messen, nicht gegen die Migrations-Fixtur.
    if (vorwert) {
      writeFileSync(dataPfad, vorwert);
      await pluginNeuLaden(cdp);
    }
    await abschnittEinstellungen(cdp);
    await abschnittDeklarativ(cdp);
    await abschnittDrittanbieter(cdp);
  } finally {
    // Zurueckschreiben und das Ergebnis MESSEN statt darauf vertrauen.
    if (vorwert) {
      writeFileSync(dataPfad, vorwert);
      await pluginNeuLaden(cdp);
      const jetzt = readFileSync(dataPfad);
      const gleich = jetzt.equals(vorwert);
      console.log(
        gleich
          ? "\ndata.json zurueckgeschrieben: byte-gleich"
          : "\ndata.json ABWEICHUNG — Rettungskopie bleibt liegen: " + rettung,
      );
      if (gleich && !KEEP && existsSync(rettung)) rmSync(rettung);
    }
    await cdp.evaluate(`app.setting.close(); return true;`).catch(() => undefined);

    // Übersprungenes gehört IN die Abschlusszeile, nicht nur in die Zeile daneben: sonst
    // wird aus „13/13 grün" beim Zitieren ein bestandener Smoke, obwohl ein Teil nie
    // gemessen wurde.
    const rot = checks.filter((c) => !c.passed);
    const uebersprungen = checks.filter((c) => c.skipped);
    const gemessen = checks.length - uebersprungen.length;
    console.log(
      `\n${gemessen - rot.length}/${gemessen} gemessene Prüfpunkte grün`
      + (uebersprungen.length > 0 ? ` · ${uebersprungen.length} übersprungen` : ""),
    );
    for (const c of rot) console.log(`  ✗ ${c.name} — ${c.detail}`);
    for (const c of uebersprungen) console.log(`  · ${c.name} — ${c.detail}`);
    cdp.close();
    if (rot.length > 0) process.exitCode = 1;
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof PreconditionError) {
    console.error(`\nAbbruch — Umgebungsbedingung nicht erfüllt:\n${e.message}`);
    process.exitCode = 2;   // eigener Code: nicht gemessen ist nicht dasselbe wie durchgefallen
  } else {
    throw e;
  }
}
