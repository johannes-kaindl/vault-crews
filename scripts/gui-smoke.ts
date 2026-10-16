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
 * Zweitinstanz mit eigenem Profil und eigenem Port, nie die regulaere Instanz (kein `quit`,
 * kein Neustart fremder Fenster). `--port` ist Pflicht.
 *
 * ```bash
 * UD=/tmp/obs-test-vault-crews; mkdir -p "$UD"
 * lsof -nP -iTCP:<port> -sTCP:LISTEN; pgrep -f "user-data-dir=$UD"      # beides leer
 * cp ~/Library/Application\ Support/obsidian/obsidian-*.asar "$UD"/      # aktuelle Version
 * # $UD/obsidian.json: {"vaults":{"vc":{"path":"$STAGING_VAULTS_DIR/vault-crews","ts":1,"open":true}},"language":"en"}
 * npm run build && npm run shots -- --setup     # baut den Staging-Vault aus docs/images/fixture/
 * OBSIDIAN_PLUGIN_DIR="$STAGING_VAULTS_DIR/vault-crews/.obsidian/plugins/vault-crews" npm run deploy
 * python3 ~/.claude/hooks/obsidian-cdp-lock.py acquire --label vault-crews --intent "GUI-Smoke" --exclusive focus --port <port> --ttl 300
 * /Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir="$UD" --remote-debugging-port=<port> &
 * npm run smoke:gui -- --vault vault-crews --port <port> [--keep] [--ohne-modell]
 * python3 ~/.claude/hooks/obsidian-cdp-lock.py release
 * ```
 *
 * `--folge-gegenprobe` hängt einen Beobachter an den Strombereich, der nach jeder Änderung ans Ende scrollt (ein Plugin, das das
 * Hochscrollen überschreibt): erwartet ist genau der Punkt „Hochscrollen wird respektiert“ rot, alle anderen unverändert.
 * `--ohne-modell` lässt den Punkt „echtes Modell“ (w11, POST an :1234) aus und führt ihn als nichts gemessen (Wellen-Regel:
 * kein Lauf schickt eine Anfrage an LM Studio/Ollama). `--keep` lässt `data.json.smoke-rettung` liegen — vor dem nächsten Lauf löschen,
 * sonst meldet „Keine liegen gebliebene Rettungskopie“ rot.
 * Je Messlauf ein frischer Prozess; der erste Lauf nach einer Profilanlage ist ein Aufwaermlauf.
 * Exit 0 gruen/uebersprungen, 1 bei Rot oder „nichts gemessen", 2 bei Abbruch.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { AbbruchAusnahme, attachTo, beimAbbruch, bereiteInstanzVor, Cdp, entferneFakeManager, installFakeManager, clearNotices, istAbgebrochen, ladePluginNeu, notices, pollUntil, requireVisible } from "../../tools/obsidian-cdp/cdp.js";
import { createBilanz, parseArgs, runDriver, Vorbedingung } from "../../tools/obsidian-cdp/bilanz.js";
import { messeFolge, zeichneFolge } from "../../tools/obsidian-cdp/folge.js";
import { startLlmStub, type LlmStub } from "../../tools/obsidian-cdp/llm-stub.js";
import { capture } from "../../tools/obsidian-cdp/shot.js";

const PLUGIN_ID = "vault-crews";

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.value("port") ?? "");
const VAULT = args.has("vault") ? (args.value("vault") ?? "") : undefined;
const KEEP = args.has("keep");
const OHNE_MODELL = args.has("ohne-modell");
/** Gegenprobe der Folge-Messung (README der Brücke § Folge-Messung): ein Beobachter setzt nach jeder Änderung `scrollTop = scrollHeight`,
 *  wie ein Plugin, das ein Hochscrollen überschreibt. Erwartet: genau der Punkt „Hochscrollen wird respektiert“ wird rot. */
const FOLGE_GEGENPROBE = args.has("folge-gegenprobe");

// --- Prüfpunkte --------------------------------------------------------------

// Bilanz in vier Zuständen (grün · rot · übersprungen · nichts gemessen), Exit 1 bei Rot ODER
// nichts gemessen (Modul `tools/obsidian-cdp/bilanz.ts`, CORE-TEST-19). Die Aufrufstellen behalten
// ihre Form: `record(name, passed, detail)`, `skipped(name, grund)` und neu `unmeasured(name, grund)`.
// Soll-Liste (der Nenner): ein Punkt, der nie aufgezeichnet wird, zählt als „nichts gemessen“. Sie wird
// statisch gegen alle `record`/`unmeasured`/`skipped`-Namen dieser Datei geprüft: ein Name außerhalb der Liste
// bricht den Typecheck (Union), ein Name in der Liste ohne Aufrufstelle fiele als „nichts gemessen“ auf.
const P_STREAM = "Welle 11 — echtes Modell: die Antwort kommt gestreamt und vollständig";
const P_FALLBACK = "Welle 11 — Server ohne CORS: der Lauf bekommt seine Antwort über den Fallback ohne Stream";
const P_TIMEOUT = "Welle 11 — Server schweigt von Anfang an: harter Gesamt-Timer meldet timeout";
const P_STALL = "Welle 11 — Server bricht nach dem ersten Chunk ab: Stall-Detektor meldet stalled";
const P_FOLGE = "Welle 20 — Folge-Regel: Hochscrollen mitten im Strom wird respektiert";
const P_KONTROLLE = "Welle 20 — Folge-Regel (Kontrolle): ohne Störung folgt der Strom dem Ende";
const P_WIEDERAUFNAHME = "Welle 20 — Folge-Regel (Wiederaufnahme): steht der Nutzer wieder unten, folgt der Strom wieder";
const P_DENKBLOCK = "Welle 20 — Denkblock live: der Denktext wächst während des Stroms, die Zusammenfassung zählt mit";
const P_STATUSSYMBOLE = "Welle 23 — Aufgabenzeilen: Status-Symbol mit Zustandsklasse, Textalternative und bewegtem Lauf-Symbol";
const P_KONTROLLE_ABSATZ = "Welle 20 — Folge-Regel (Kontrolle, absatzgroße Stücke): der Strom folgt auch bei Stücken über der Schwelle";
const N1_PUNKT = "N1 Abschnitt Request ist vorhanden, klappt auf und zeigt die Felder";
const PUNKTE = [
  "Alte Endpunkt-Liste wird zu genau einem Eintrag",
  "Das alte globale Modell landet in der Zeile und geht nicht verloren",
  "Das globale Modellfeld existiert nicht mehr",
  "Die übrigen Einstellungen überstehen die Migration",
  "Ein kaputtes data.json-Feld reisst den Plugin-Start nicht mit",
  "Einstellungs-Tab öffnet",
  "Endpunkt-Zeile zeichnet ein URL-Feld",
  "Endpunkt-Zeile zeichnet ein Schlüsselfeld",
  "Endpunkt-Zeile zeichnet ein Modellfeld",
  "Die Sperrliste ist ein mehrzeiliges Textfeld",
  "Kein roher Übersetzungs-Schlüssel im Tab",
  "Kein globales Feld „Standardmodell\" mehr",
  "Schlüssel führt zum Drittanbieter-Hinweis",
  "Deklarative API vorhanden",
  "Tab liefert Definitionen und der Host uebernimmt sie",
  "keine versteckten und keine stummen Zeilen",
  "Hilfe-Zeile ist das erste Element und die erste Zeile im Tab",
  "Einstellungen erscheinen in Obsidians Einstellungs-Suche",
  "Fallback-Pfad (< 1.13) zeichnet dieselbe Struktur",
  "Panel — Abschnitt lief bis zum Ende",
  "Panel — crewRoot ist bespielbar",
  "Panel — öffnet auf den eigenen Befehl",
  "Panel — Inhalt ist gerendert, bevor gemessen wird",
  "Panel — Hub-Leiste: zwei Tabs mit gerendertem Icon, ARIA-Rollen, erster Tab aktiv",
  "Panel — Wechsel auf den Verlauf zeichnet ihn, der inaktive Tab ist leer, zurück zeichnet die Crews neu",
  "Panel — Abbrechen-Knopf liegt während eines Laufs im Leaf-Rechteck",
  P_FOLGE,
  P_KONTROLLE,
  P_WIEDERAUFNAHME,
  P_DENKBLOCK,
  P_STATUSSYMBOLE,
  P_KONTROLLE_ABSATZ,
  "Welle 20 — Abschnitt lief bis zum Ende",
  "Panel — kein Streuner-Hinweis ohne Anlass",
  "Panel — verirrte Crew-Datei wird benannt, ohne das Panel neu zu öffnen",
  "Panel — ungültige Crew trägt ein Warndreieck mit Fehlertext",
  "Panel — die ungültige Crew bleibt startbar",
  "Panel — der Hinweis verschwindet wieder (Gegenprobe)",
  "Welle 8 — Abschnitt lief bis zum Ende",
  "Welle 8 — Knopf „Beispiel-Crews installieren“ ist da",
  "Welle 8 — der Settings-Knopf installiert die Beispiel-Crews",
  "Welle 8 — kein Verweis mehr auf die Befehlspalette",
  "Welle 8 — Ausblenden aus: kein Regelsatz für den Crew-Ordner",
  "Welle 8 — Ausblenden an: Regelsatz für den Crew-Ordner steht",
  "Welle 8 — Crew-Ordner im Explorer tatsächlich unsichtbar",
  "Welle 18 — Pop-out aktiv: Regel im Hauptfenster, nicht im Pop-out",
  "Welle 18 — Laden bei aktivem Pop-out: Regel steht im Hauptfenster",
  "Welle 8 — Ausblenden wieder aus: Regelsatz weg (Gegenprobe)",
  "Welle 8 — Lauf bekommt den Manager-Endpunkt samt Schlüssel und Modell",
  "Welle 8 — Einstellungen zeigen bei Manager den Manager-Baustein",
  "Welle 8 — ohne Manager gilt wieder die lokale Liste (Gegenprobe)",
  "Welle 8 — ohne Manager kein Manager-Baustein in den Einstellungen",
  "Welle 8 — Lauf mit leerem Collector endet",
  "Welle 8 — der leere Collector ist als Ursache im Ergebnis",
  "Welle 8 — kein Modellaufruf auf leerem Kontext",
  "Welle 8 — Notice nennt „0 Notizen“ und die Quelle statt „0 Dateien“",
  "Welle 8 — Notice trägt den Link zum Protokoll",
  "Welle 8 — Klick auf den Link öffnet run.md dieses Laufs",
  "Welle 8 — run.md nennt Quelle und übersprungenen Task",
  "Welle 8 — Ergebnis-Karte nennt die leere Quelle",
  "Welle 8 — Crew-Zeile im Panel nennt die leere Quelle",
  P_STREAM,
  P_FALLBACK,
  P_TIMEOUT,
  P_STALL,
  "N2-1 Body am Draht trägt Profilwerte (qwen3.8, Modus structured)",
  "N2-2 Überschreibung des Plugins ändert den Body (Gegenprobe zu N2-1)",
  "N2-3 Persona schlägt Überschreibung und Profil (Temperatur 0.4 statt 0.3, Budget 1500)",
  "N2-4 thinking: on in der Persona sendet die Stufe medium und hebt das Budget (Reserve der Familie)",
  "N2-5 Die Sitzung zeigt, was wirklich gesendet wurde (letzte Anfrage = Body des vierten Laufs)",
  "N1-2 „Letzte Anfrage“ trägt die Anfrage aus N2 (Tab liest die Sitzung beim Öffnen neu)",
  "N1-3 Der Persona-Hinweis steht im Abschnitt",
  "N1-4 Überschreiben und Zurücksetzen nacheinander: Abschnitt bleibt offen, Wert wird gespeichert und wieder gelöscht",
  "Welle 14 — Abschnitt lief bis zum Ende",
  "Welle 15 — Schlüsselbund: nach dem Auflösen steht kein Schlüssel mehr in data.json",
  "Welle 15 — Schlüsselbund: der Schlüssel liegt im Schlüsselbund",
  "Welle 15 — Schlüsselbund: der Lauf bekommt den Schlüssel von dort (nur im Speicher)",
  "Welle 15 — Schwärzung: PEM und Bearer-Token gehen nicht im Klartext an den Server",
  "Welle 15 — Wiederherstellung (JSON-Schema): die Notiz trägt PEM und Token im Original, kein Platzhalter",
  "Welle 15 — Wiederherstellung (Markdown-Schema): das PEM kommt im Wortlaut des Prompts zurück, nicht ein zweites Mal maskiert",
  "Welle 15 — 401-Body: der Schlüssel wird in run.md und state.json maskiert",
  "Welle 15 — der Schlüssel kommt aus dem Schlüsselbund an den Draht (Authorization-Kopf)",
  "Welle 15 — Abschnitt lief bis zum Ende",
  "Keine liegen gebliebene Rettungskopie aus einem abgebrochenen Vorlauf",
  N1_PUNKT,
] as const;
type Punktname = (typeof PUNKTE)[number];
const bilanz = createBilanz({ punkte: PUNKTE });
const record = (name: Punktname, passed: boolean, detail: string): void => bilanz.record(name, passed, detail);
/** Der Punkt ist nicht anwendbar (z. B. ein echter Manager ist geladen) — mit Grund, aber nichts gemessen. */
const skipped = (name: Punktname, reason: string): void => bilanz.skipped(name, reason);
/** Der Gegenstand des Punkts wurde nicht erreicht (Vorbedingung fehlt) — „nichts gemessen", nie grün. */
const unmeasured = (name: Punktname, reason: string): void => bilanz.unmeasured(name, reason);
/** Eine Vorbedingung gilt für eine ganze Gruppe von Punkten: alle als nicht anwendbar führen. */
const alleUebersprungen = (namen: readonly Punktname[], reason: string): void => { for (const n of namen) skipped(n, reason); };

/** Verletzte Umgebungsbedingung (Klasse `Vorbedingung` des Moduls `bilanz`) — KEIN Befund am Prüfling.
 *
 *  Der Unterschied ist die halbe Regel (CORE-TEST-02 g): „antwortet nicht" ist die fehlende
 *  Umgebung und bricht mit Ansage ab; „antwortet falsch" ist ein Befund und bleibt rot. Wer
 *  beides zusammenwirft, verbucht den gesuchten Defekt als Nichtmessung — dann läuft die
 *  Gegenprobe durch, ohne rot zu werden. */

// --- Helfer ------------------------------------------------------------------

/** Plugin neu laden, ohne Obsidian anzufassen — das ist der Pfad, auf dem `loadSettings`
 *  und damit die Migration läuft. */
async function pluginNeuLaden(cdp: Cdp, beruhigungMs = 900): Promise<void> {
  await cdp.evaluate(`
    await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
    await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
    ${beruhigungMs > 0 ? `await new Promise((r) => setTimeout(r, ${beruhigungMs}));` : ""}
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
  return attachTo("settings", PORT, PLUGIN_ID);
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
    unmeasured("Einstellungs-Tab öffnet", "Tab nicht greifbar — Gegenstand nicht erreicht");
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
    unmeasured("Endpunkt-Zeile zeichnet ein URL-Feld", "Tab-Inhalt nicht gefunden (gilt auch für Schlüssel-, Modellfeld, Sperrliste)");
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
    unmeasured("Kein roher Übersetzungs-Schlüssel im Tab", "Tab-Inhalt nicht gefunden — Gegenstand nicht erreicht");
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
    unmeasured("Schlüssel führt zum Drittanbieter-Hinweis", "Tab-Inhalt nicht gefunden — Gegenstand nicht erreicht");
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
    unmeasured("Deklarative API vorhanden", "Einstellungen-Tab nicht zu oeffnen (gilt für alle Punkte dieses Abschnitts)");
    return;
  }

  // Die Definitionen leben im HAUPTfenster: das ausgelagerte Einstellungen-Fenster hat ab
  // 1.13 einen eigenen JS-Kontext und kennt kein `app` (Fund yijing-oracle 2026-08-16).
  const defs = await cdp.evaluate<{
    hatUpdate: boolean;
    gruppen: number;
    leereGruppen: number;
    uebernommen: number | null;
    elemente: number;
    hilfeErstes: boolean;
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
      // Die Hilfe-Zeile ist das ERSTE Element und keine Gruppe: Gruppen sind die Elemente mit items.
      gruppen: d.filter((g) => g.items).length,
      leereGruppen: d.filter((g) => g.items && !g.items.length).length,
      elemente: d.length,
      hilfeErstes: Boolean(d[0] && !d[0].items && !d[0].heading && typeof d[0].render === "function"),
      uebernommen: Array.isArray(tab.settingItems) ? tab.settingItems.length : null,
      mitVisible: alle.filter((i) => i.visible !== undefined).length,
      stumm: alle.filter((i) => !i.heading && !i.items && !i.control && !i.render).length,
      suchbegriff: (d[2] && d[2].items && d[2].items[0] && d[2].items[0].name) || null,
      pluginName: app.plugins.manifests[${JSON.stringify(PLUGIN_ID)}].name,
    };
  `);

  if (!defs) {
    record("Deklarative API vorhanden", false, "getSettingDefinitions() fehlt am aktiven Tab");
    await cdp.evaluate(`app.setting.close(); return true;`).catch(() => undefined);
    return;
  }
  record("Deklarative API vorhanden", true, "getSettingDefinitions() liefert Definitionen");
  if (!defs.hatUpdate) {
    alleUebersprungen([
      "Tab liefert Definitionen und der Host uebernimmt sie",
      "keine versteckten und keine stummen Zeilen",
      "Hilfe-Zeile ist das erste Element und die erste Zeile im Tab",
      "Einstellungen erscheinen in Obsidians Einstellungs-Suche",
      "Fallback-Pfad (< 1.13) zeichnet dieselbe Struktur",
    ], "Obsidian ohne native 1.13-Settings-API (nur Fallback-Pfad)");
    await cdp.evaluate(`app.setting.close(); return true;`).catch(() => undefined);
    return;
  }

  record(
    "Tab liefert Definitionen und der Host uebernimmt sie",
    defs.gruppen > 0 && defs.leereGruppen === 0 && defs.uebernommen === defs.elemente,
    `${defs.gruppen} Gruppen (+ Hilfe-Zeile = ${defs.elemente} Elemente), ${defs.leereGruppen} leer, vom Host uebernommen: ${String(defs.uebernommen)}`,
  );

  // Die beiden Fallstricke aus REGISTRY.md, gemessen statt geglaubt: bedingte Zeilen
  // gehoeren weggelassen (`visible` wirkt nicht), und jede Zeile braucht einen Regler
  // oder einen eigenen Renderer (sonst ueberspringt der native Renderer sie).
  record(
    "keine versteckten und keine stummen Zeilen",
    defs.mitVisible === 0 && defs.stumm === 0,
    `${defs.mitVisible} Zeilen mit visible, ${defs.stumm} ohne Regler/Renderer`,
  );

  // Hilfe-Zeile (UI-STANDARD §8): erstes Element der Definitionen UND erste gezeichnete Zeile,
  // mit Text-Knopf und bug-Icon. Geklickt wird nicht — ein Klick oeffnet den System-Browser;
  // die URLs prueft der Unit-Test. Der Screenshot (SMOKE_SHOT_DIR) ist zum Ansehen.
  const hilfe = await ui.evaluate<{ name: string; knopf: boolean; bug: boolean } | null>(`
    const c = document.querySelector(".vertical-tab-content");
    const z = c && c.querySelector(".setting-item");
    if (!z) return null;
    const n = z.querySelector(".setting-item-name");
    return { name: n ? n.textContent : "", knopf: Boolean(z.querySelector("button")), bug: Boolean(z.querySelector(".clickable-icon")) };
  `);
  record(
    "Hilfe-Zeile ist das erste Element und die erste Zeile im Tab",
    defs.hilfeErstes && hilfe !== null && /^(Help|Hilfe)$/.test(hilfe.name) && hilfe.knopf && hilfe.bug,
    `Definition zuerst: ${String(defs.hilfeErstes)} · erste Zeile: ${JSON.stringify(hilfe)}`,
  );
  const shotDir = process.env.SMOKE_SHOT_DIR;
  if (shotDir) writeFileSync(`${shotDir}/hilfe-zeile.png`, await capture(ui));

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
    // Bewusst ROT statt übersprungen: kein ableitbarer Suchbegriff heißt, dass die
    // Definitionen leer oder umgebaut sind — und ohne Definitionen findet die Suche
    // nachweislich nichts. Genau das ist der Defekt, den dieser Abschnitt messen soll.
    // (Die Gegenprobe gegen den Vor-Stand hat diesen Skip als Lücke aufgedeckt: er ließ
    // den Defektfall wie „nicht gemessen" aussehen statt wie „durchgefallen".)
    record(
      "Einstellungen erscheinen in Obsidians Einstellungs-Suche",
      false,
      "kein Suchbegriff aus den Definitionen ableitbar — sie sind leer oder umgebaut",
    );
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

// --- Abschnitt: Panel — die drei stummen Zustände -----------------------------

/** Wartet auf eine Bedingung im Renderer und meldet, OB sie eintrat — statt zu werfen.
 *  Ein Prüfpunkt soll rot werden, nicht den Lauf abbrechen. Der Ausdruck wird hier in
 *  `return Boolean(...)` gewickelt, weil `cdp.evaluate` einen Funktionskörper nimmt: ein
 *  Ausdruck ohne `return` ist still falsy und liefe in jeden Timeout. */
async function wartetAuf(cdp: Cdp, ausdruck: string, timeoutMs = 6000): Promise<boolean> {
  return Boolean(await pollUntil<boolean>(cdp, `return Boolean(${ausdruck});`, timeoutMs, 250));
}

/** Legt eine Crew-Datei an und gibt "ok" oder den Fehlertext des Renderers zurueck.
 *  `cdp.evaluate` wirft bei einer Renderer-Ausnahme nur „Uncaught" — der Grund bleibt drin
 *  stecken. Hier wird er gefangen und als Wert herausgereicht, damit er im Pruefpunkt steht. */
async function anlegen(cdp: Cdp, pfad: string): Promise<string> {
  return await cdp.evaluate<string>(`
    try {
      const inhalt = ["---", "crew-kind: team", "---", ""].join(String.fromCharCode(10));
      await app.vault.create(${JSON.stringify(pfad)}, inhalt);
      return "ok";
    } catch (e) { return (e && e.message) ? e.message : String(e); }
  `);
}

const PANEL = `document.querySelector('.workspace-leaf-content[data-type="vault-crews-panel"]')`;

/**
 * Misst die drei Lagen, in denen das Panel bis 0.9.5 schwieg — und misst dabei zwei davon
 * in EINEM Zug: die verirrte Datei wird angelegt, **während das Panel offen steht**. Sie
 * kann dort also nur erscheinen, wenn der Vault-Watcher greift (Punkt 2) UND die Zählung
 * stimmt (Punkt 1). Ohne Watcher bliebe das Panel stumm, bis jemand es neu öffnet.
 *
 * Der Abschnitt legt zwei Dateien im crewRoot an und räumt sie im `finally` wieder weg;
 * die Gegenprobe „Hinweis verschwindet wieder" ist selbst ein Prüfpunkt — ein Hinweis, der
 * bleibt, wäre so falsch wie einer, der nie kommt.
 */
async function abschnittPanel(cdp: Cdp): Promise<void> {
  try {
    await panelMessungen(cdp);
    record("Panel — Abschnitt lief bis zum Ende", true, "kein Abbruch");
  } catch (e) {
    if (e instanceof AbbruchAusnahme || istAbgebrochen()) throw e;   // ein Abbruch ist kein Befund und wird nicht als „rot“ verbucht
    // Gemessen 2026-09-02: ein Absturz mitten im Abschnitt liess drei Pruefpunkte weg, und
    // die Schlusszeile meldete trotzdem „20/20 gemessene Pruefpunkte gruen". Nicht erreicht
    // ist nicht dasselbe wie bestanden.
    record("Panel — Abschnitt lief bis zum Ende", false,
      `abgebrochen: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function panelMessungen(cdp: Cdp): Promise<void> {
  const root = await cdp.evaluate<string>(
    `return app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].settings.crewRoot;`,
  );
  if (!root) {
    unmeasured("Panel — verirrte Crew-Datei wird benannt, ohne das Panel neu zu öffnen", "crewRoot nicht lesbar");
    unmeasured("Panel — ungültige Crew trägt ein Warndreieck mit Fehlertext", "crewRoot nicht lesbar");
    return;
  }
  const verirrt = `${root}/zz-smoke-verirrt.md`;
  const kaputt = `${root}/teams/zz-smoke-kaputt.md`;

  // Der crewRoot ist eine Einstellung und kann nach dem Migrations-Abschnitt auf einen Ordner
  // zeigen, den es im Vault nicht gibt — `app.vault.create` wirft dann, und zwar im Renderer.
  // Beides absichern: Ordner anlegen, und den Wert in die Detailzeile schreiben, damit ein
  // Fehlschlag nicht raten laesst, gegen WELCHEN Ordner gemessen wurde.
  const ordnerDa = await cdp.evaluate<string>(`
    try {
      for (const d of [${JSON.stringify("${root}")}, ${JSON.stringify("${root}")} + "/teams"]) {
        if (!app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d);
      }
      return "ok";
    } catch (e) { return "Ordner fehlt und laesst sich nicht anlegen: " + (e && e.message ? e.message : String(e)); }
  `.replace(/\$\{root\}/g, root));
  if (ordnerDa !== "ok") {
    record("Panel — crewRoot ist bespielbar", false, `crewRoot „${root}": ${ordnerDa}`);
    return;
  }
  record("Panel — crewRoot ist bespielbar", true, `crewRoot „${root}"`);

  await cdp.evaluate(`await app.commands.executeCommandById("${PLUGIN_ID}:open-crews-panel"); return true;`);
  // KEIN skipped() hier: ein Panel, das auf seinen eigenen Befehl nicht aufgeht, ist ein
  // Befund am Prüfling, keine fehlende Umgebung. `skipped` zählt als grün — wer das
  // verwechselt, verbucht den gesuchten Defekt als Nichtmessung (gemessen 2026-09-02 in
  // obsidian-transmute: zwei Punkte standen monatelang „übersprungen", Bilanz sah 25/25 aus).
  if (!await wartetAuf(cdp, PANEL)) {
    record("Panel — öffnet auf den eigenen Befehl", false, "Panel-Blatt erschien nicht");
    return;
  }
  record("Panel — öffnet auf den eigenen Befehl", true, "Panel-Blatt erschien");

  // Vor der Abwesenheits-Messung warten, bis der Panel-INHALT steht. Sonst misst der
  // Prüfpunkt unten nur, dass noch nichts gerendert ist — eine Abwesenheit ist erst dann
  // eine Aussage, wenn die Anwesenheit überhaupt möglich war. (Dieselbe Klasse Fehler wie
  // ein Klick vor der ersten UI-Freigabe: die Messung misst ihren eigenen Zeitpunkt.)
  const inhaltDa = await wartetAuf(cdp,
    `${PANEL}.querySelector(".vault-crews-team-list, .vault-crews-empty")`);
  record("Panel — Inhalt ist gerendert, bevor gemessen wird", inhaltDa,
    inhaltDa ? "Team-Liste oder Empty-State steht" : "weder Liste noch Empty-State nach 6s");

  // Hub-Tab-Leiste (Kit `buildHubInto`, seit Welle 20): Gegenstand ist die Leiste selbst, nicht der Inhalt.
  // Der Text der Beschriftung ist sprachabhängig, deshalb Anzahl, Rolle und Icon statt Wortlaut.
  const hub = await cdp.evaluate<{ tabs: number; rollen: boolean; icons: boolean; labels: string[]; erster: string | null }>(`
    const tabs = [...${PANEL}.querySelectorAll(".okit-hub-tab")];
    return {
      tabs: tabs.length,
      rollen: tabs.length > 0 && tabs.every((b) => b.getAttribute("role") === "tab")
        && ${PANEL}.querySelectorAll('[role="tablist"]').length === 1,
      icons: tabs.length > 0 && tabs.every((b) => (b.querySelector(".okit-hub-tab-icon")?.innerHTML ?? "").length > 0),
      labels: tabs.map((b) => b.querySelector(".okit-hub-tab-label")?.textContent ?? ""),
      erster: tabs[0]?.getAttribute("aria-selected") ?? null,
    };
  `);
  record("Panel — Hub-Leiste: zwei Tabs mit gerendertem Icon, ARIA-Rollen, erster Tab aktiv",
    hub.tabs === 2 && hub.rollen && hub.icons && hub.erster === "true" && hub.labels.every((l) => l.length > 0),
    `Tabs ${hub.tabs} · Rollen ${hub.rollen} · Icons ${hub.icons} · Labels ${JSON.stringify(hub.labels)} · aria-selected[0] ${String(hub.erster)}`);

  const wechsel = await cdp.evaluate<{ verlauf: boolean; crewsLeer: boolean; zurueck: boolean }>(`
    const tabs = [...${PANEL}.querySelectorAll(".okit-hub-tab")];
    const warte = (ms) => new Promise((r) => setTimeout(r, ms));
    const panel = (id) => ${PANEL}.querySelector('.okit-hub-panel[data-tab="' + id + '"]');
    tabs[1]?.click(); await warte(500);
    const verlauf = Boolean(panel("history")?.querySelector(".vault-crews-empty, .vault-crews-summary, .vault-crews-history-list"))
      && !panel("history")?.classList.contains("is-hidden") && panel("crews")?.classList.contains("is-hidden") === true;
    const crewsLeer = (panel("crews")?.children.length ?? -1) === 0;
    tabs[0]?.click(); await warte(500);
    const zurueck = Boolean(panel("crews")?.querySelector(".vault-crews-team-list, .vault-crews-empty"))
      && panel("history")?.classList.contains("is-hidden") === true;
    return { verlauf, crewsLeer, zurueck };
  `);
  record("Panel — Wechsel auf den Verlauf zeichnet ihn, der inaktive Tab ist leer, zurück zeichnet die Crews neu",
    wechsel.verlauf && wechsel.crewsLeer && wechsel.zurueck,
    `Verlauf gezeichnet ${wechsel.verlauf} · Crews-Panel leer ${wechsel.crewsLeer} · Crews wieder da ${wechsel.zurueck}`);
  // Der Abbrechen-Knopf existiert nur während eines Laufs: er wird in `w20Lauf` gemessen (Lauf gegen den zentralen Stub).

  // Ausgangslage: ohne Anlass kein Hinweis. Ohne diese Messung wäre ein Hinweis, der
  // IMMER steht, von einem korrekt erschienenen nicht zu unterscheiden.
  const vorher = await cdp.evaluate<boolean>(`return Boolean(${PANEL}.querySelector(".vault-crews-stray"));`);
  record("Panel — kein Streuner-Hinweis ohne Anlass", vorher === false,
    vorher === false ? "kein .vault-crews-stray im Ausgangszustand" : "Hinweis stand schon vor der Testdatei");

  try {
    const angelegt = await anlegen(cdp, verirrt);
    if (angelegt !== "ok") {
      record("Panel — verirrte Crew-Datei wird benannt, ohne das Panel neu zu öffnen", false,
        `Testdatei „${verirrt}" liess sich nicht anlegen: ${angelegt}`);
      return;
    }
    const kam = await wartetAuf(cdp, `${PANEL}.querySelector(".vault-crews-stray")`);
    const text = kam
      ? await cdp.evaluate<string>(`return ${PANEL}.querySelector(".vault-crews-stray").textContent;`)
      : "";
    record("Panel — verirrte Crew-Datei wird benannt, ohne das Panel neu zu öffnen",
      kam && text.includes("1"),
      kam ? `Hinweis erschien: „${text.slice(0, 70)}…"` : "kein .vault-crews-stray nach dem Anlegen");

    const angelegt2 = await anlegen(cdp, kaputt);
    if (angelegt2 !== "ok") {
      record("Panel — ungültige Crew trägt ein Warndreieck mit Fehlertext", false,
        `Testdatei „${kaputt}" liess sich nicht anlegen: ${angelegt2}`);
      return;
    }
    const warn = await wartetAuf(cdp, `${PANEL}.querySelector(".vault-crews-team-problem")`);
    const label = warn
      ? await cdp.evaluate<string>(`return ${PANEL}.querySelector(".vault-crews-team-problem").getAttribute("aria-label");`)
      : "";
    // Form UND Farbe UND aria-label (UI-STANDARD §8): ein Dreieck ohne Text sagt nur „irgendwas".
    record("Panel — ungültige Crew trägt ein Warndreieck mit Fehlertext",
      warn && typeof label === "string" && label.length > 0,
      warn ? `aria-label: „${String(label).slice(0, 70)}…"` : "kein .vault-crews-team-problem");

    // Die Zeile muss STARTBAR bleiben — das ist Absicht, nicht Nachlässigkeit: der
    // Preflight zeigt den vollständigen Fehler, das Dreieck nimmt nur den Umweg ab.
    const startbar = await cdp.evaluate<boolean>(`
      const row = ${PANEL}.querySelector(".vault-crews-team-problem")?.closest(".vault-crews-team-row");
      return Boolean(row && row.querySelector("button.vault-crews-run"));
    `);
    record("Panel — die ungültige Crew bleibt startbar", startbar === true,
      startbar ? "Ausführen-Knopf in derselben Zeile vorhanden" : "kein Ausführen-Knopf in der Warnzeile");
  } finally {
    await cdp.evaluate(`
      for (const p of [${JSON.stringify(verirrt)}, ${JSON.stringify(kaputt)}]) {
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      return true;
    `).catch(() => undefined);
    const weg = await wartetAuf(cdp, `!${PANEL}.querySelector(".vault-crews-stray")`);
    record("Panel — der Hinweis verschwindet wieder (Gegenprobe)", weg,
      weg ? "kein .vault-crews-stray nach dem Löschen" : "Hinweis blieb stehen");
  }
}

// --- Abschnitt: Welle 8 — Beispiel-Knopf, Lauf-Transparenz, Ordner ausblenden, Manager -----

const PLUGIN = `app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]`;
const BEISPIEL_PFADE = [
  "agents/triage-analyst.md", "agents/briefing-autor.md", "teams/task-triage.md", "teams/daily-briefing.md",
  "runs/runs.base", "agents/notiz-tagger.md", "agents/reifegrad-tagger.md", "teams/notiz-tagger.md", "teams/reifegrad-tagger.md",
];

/** Text des Einstellungs-Fensters (zwei Sprachen, deshalb Muster statt Literal). */
async function einstellungenText(cdp: Cdp): Promise<{ ui: Cdp | null; text: string }> {
  const ui = await einstellungenOeffnen(cdp);
  if (!ui) return { ui: null, text: "" };
  return { ui, text: (await tabText(ui)) ?? "" };
}

async function abschnittWelle8(cdp: Cdp): Promise<void> {
  try {
    await w8Beispielknopf(cdp);
    await w8Ausblenden(cdp);
    await w8Manager(cdp);
    await w8LeererCollector(cdp);
    await w11ChatClient(cdp);
    record("Welle 8 — Abschnitt lief bis zum Ende", true, "kein Abbruch");
  } catch (e) {
    if (e instanceof AbbruchAusnahme || istAbgebrochen()) throw e;   // ein Abbruch ist kein Befund und wird nicht als „rot“ verbucht
    record("Welle 8 — Abschnitt lief bis zum Ende", false, `abgebrochen: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Punkt 1: der Knopf in den Einstellungen installiert wirklich. Vorher alle Ziele merken und
 *  hinterher nur wegraeumen, was der Knopf selbst angelegt hat — vorhandene Crews bleiben. */
async function w8Beispielknopf(cdp: Cdp): Promise<void> {
  const root = await cdp.evaluate<string>(`return ${PLUGIN}.settings.crewRoot.replace(/\\/+$/, "");`);
  const vorher = await cdp.evaluate<string[]>(
    `return ${JSON.stringify(BEISPIEL_PFADE)}.filter((p) => app.vault.getAbstractFileByPath(${JSON.stringify(root + "/")} + p));`,
  );
  const neu = BEISPIEL_PFADE.filter((p) => !vorher.includes(p));
  try {
    await clearNotices(cdp);
    const { ui } = await einstellungenText(cdp);
    if (!ui) { unmeasured("Welle 8 — Knopf „Beispiel-Crews installieren“ ist da", "Tab nicht greifbar (gilt auch für die zwei Folgepunkte)"); return; }
    const geklickt = await ui.evaluate<boolean>(`
      const wurzel = document.querySelector(".modal.mod-settings .vertical-tab-content") || document.querySelector(".vertical-tab-content");
      const knopf = [...(wurzel?.querySelectorAll("button") ?? [])].find((b) => /beispiel-crews installieren|install example crews/i.test(b.textContent ?? ""));
      if (!knopf) return false;
      knopf.click();
      return true;
    `);
    record("Welle 8 — Knopf „Beispiel-Crews installieren“ ist da", geklickt, geklickt ? "gefunden und geklickt" : "kein Knopf im Tab");
    if (!geklickt) return;
    const alleDa = await wartetAuf(cdp, `${JSON.stringify(BEISPIEL_PFADE)}.every((p) => app.vault.getAbstractFileByPath(${JSON.stringify(root + "/")} + p))`, 8000);
    record("Welle 8 — der Settings-Knopf installiert die Beispiel-Crews", alleDa,
      alleDa ? `alle ${BEISPIEL_PFADE.length} Ziele vorhanden (${neu.length} neu angelegt)` : "nach 8 s fehlen Ziele");
    const hinweis = await notices(cdp);
    const verweistAufPalette = /befehlspalette|command palette/i.test(hinweis);
    record("Welle 8 — kein Verweis mehr auf die Befehlspalette", !verweistAufPalette, hinweis ? `Notice: ${hinweis.slice(0, 80)}` : "keine Notice-Restzeichen");
  } finally {
    await cdp.evaluate(`
      for (const p of ${JSON.stringify(neu)}) {
        const f = app.vault.getAbstractFileByPath(${JSON.stringify(root + "/")} + p);
        if (f) await app.vault.delete(f);
      }
      return true;
    `).catch(() => undefined);
    await cdp.evaluate(`app.setting.close(); return true;`).catch(() => undefined);
  }
}

/** Punkt 3: Crew-Ordner im Explorer ausblenden — Stylesheet steht, greift im DOM, und die
 *  Gegenprobe (Schalter aus) raeumt es wieder weg. */
async function w8Ausblenden(cdp: Cdp): Promise<void> {
  const root = await cdp.evaluate<string>(`return ${PLUGIN}.settings.crewRoot.replace(/\\/+$/, "");`);
  const vorher = await cdp.evaluate<boolean>(`return ${PLUGIN}.settings.hideCrewFolder === true;`);
  const regel = `.nav-folder-title[data-path=${JSON.stringify(root)}]`;
  const blatt = async (): Promise<number> => cdp.evaluate<number>(`
    return app.workspace.rootSplit.doc.adoptedStyleSheets
      .filter((s) => [...s.cssRules].some((r) => r.cssText.includes(${JSON.stringify(`data-path="${root}"`)}))).length;
  `);
  try {
    await cdp.evaluate(`${PLUGIN}.settings.hideCrewFolder = false; await ${PLUGIN}.saveSettings(); return true;`);
    record("Welle 8 — Ausblenden aus: kein Regelsatz für den Crew-Ordner", (await blatt()) === 0, `Stylesheets mit Regel: ${await blatt()}`);
    await cdp.evaluate(`${PLUGIN}.settings.hideCrewFolder = true; await ${PLUGIN}.saveSettings(); return true;`);
    const an = await blatt();
    record("Welle 8 — Ausblenden an: Regelsatz für den Crew-Ordner steht", an === 1, `Stylesheets mit Regel: ${an}`);
    const dom = await cdp.evaluate<string>(`
      const el = document.querySelector(${JSON.stringify(regel)});
      return el ? getComputedStyle(el).display : "kein-Explorer-Knoten";
    `);
    if (dom === "kein-Explorer-Knoten") unmeasured("Welle 8 — Crew-Ordner im Explorer tatsächlich unsichtbar", "Datei-Explorer nicht offen/Ordner nicht gerendert — Gegenstand nicht erreicht");
    else record("Welle 8 — Crew-Ordner im Explorer tatsächlich unsichtbar", dom === "none", `display: ${dom}`);
    // Pop-out (Kit `folder-hide`): das aktive Dokument ist NICHT das Hauptfenster; die Regel muss
    // trotzdem im Hauptfenster stehen und darf im Pop-out nichts hinterlassen. Danach Neuladen bei
    // aktivem Pop-out (die Bauart, an der slide-deck 0.4.0 mit NotAllowedError nicht mehr lud).
    const po = await cdp.evaluate<boolean>(`
      const leaf = app.workspace.openPopoutLeaf();
      await new Promise((r) => setTimeout(r, 1200));
      leaf.view.containerEl.ownerDocument.defaultView.focus();
      await new Promise((r) => setTimeout(r, 500));
      window.__vcSmokePopout = leaf;
      return leaf.view.containerEl.ownerDocument !== app.workspace.rootSplit.doc;`);
    try {
      if (!po) {
        unmeasured("Welle 18 — Pop-out aktiv: Regel im Hauptfenster, nicht im Pop-out", "Pop-out-Fenster ließ sich nicht öffnen");
      } else {
        const popBlätter = `return window.__vcSmokePopout.view.containerEl.ownerDocument.adoptedStyleSheets.length;`;
        const vorherPop = await cdp.evaluate<number>(popBlätter);
        await cdp.evaluate(`${PLUGIN}.settings.hideCrewFolder = false; await ${PLUGIN}.saveSettings(); ${PLUGIN}.settings.hideCrewFolder = true; await ${PLUGIN}.saveSettings(); return true;`);
        const imHaupt = await blatt();
        const nachherPop = await cdp.evaluate<number>(popBlätter);
        record("Welle 18 — Pop-out aktiv: Regel im Hauptfenster, nicht im Pop-out", imHaupt === 1 && nachherPop === vorherPop,
          `Hauptfenster-Blätter mit Regel ${imHaupt}, Blätter im Pop-out ${vorherPop} → ${nachherPop}`);
        const geladen = await cdp.evaluate<string>(`
          try {
            await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
            await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
            await new Promise((r) => setTimeout(r, 1500));
            return app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}] ? "ok" : "Plugin nach enablePlugin nicht geladen";
          } catch (e) { return String(e); }`);
        const nachLaden = await pollUntil<boolean>(cdp, `
          const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
          if (!p) return null;
          const n = app.workspace.rootSplit.doc.adoptedStyleSheets
            .filter((s) => [...s.cssRules].some((r) => r.cssText.includes(${JSON.stringify(`data-path="${root}"`)}))).length;
          return n === 1 ? true : null;`, 6000, 300);
        record("Welle 18 — Laden bei aktivem Pop-out: Regel steht im Hauptfenster", geladen === "ok" && nachLaden !== null,
          geladen !== "ok" ? geladen : nachLaden !== null ? "Regel im Hauptfenster" : "Regel nach dem Laden nicht da");
      }
    } finally {
      await cdp.evaluate(`try { window.__vcSmokePopout?.detach(); } catch {} delete window.__vcSmokePopout; return true;`).catch(() => undefined);
    }
    await cdp.evaluate(`${PLUGIN}.settings.hideCrewFolder = false; await ${PLUGIN}.saveSettings(); return true;`);
    record("Welle 8 — Ausblenden wieder aus: Regelsatz weg (Gegenprobe)", (await blatt()) === 0, `Stylesheets mit Regel: ${await blatt()}`);
  } finally {
    await cdp.evaluate(`${PLUGIN}.settings.hideCrewFolder = ${vorher}; await ${PLUGIN}.saveSettings(); return true;`).catch(() => undefined);
  }
}

/** Punkt 5: mit einem (Fake-)Manager zeigen die Einstellungen den Manager-Baustein, und der Lauf
 *  bekommt dessen Endpunkt samt Modell; ohne ihn kehrt die lokale Liste zurueck. */
async function w8Manager(cdp: Cdp): Promise<void> {
  // Der zentrale Fake-Manager (tools/obsidian-cdp/fake-manager.ts): sichert den vorgefundenen Slot und stellt ihn am
  // Ende wieder her; `bestehend: "abbrechen"` lässt einen echten Manager unberührt (vorher eine eigene Prüfung).
  const r = await installFakeManager(cdp, {
    endpunkte: [{ id: "fake", label: "Fake-Gateway", url: "http://127.0.0.1:59999/v1", models: ["fake-modell"], apiKey: "sk-smoke" }],
    bestehend: "abbrechen",
  });
  if (!r.installiert) {
    alleUebersprungen([
      "Welle 8 — Lauf bekommt den Manager-Endpunkt samt Schlüssel und Modell",
      "Welle 8 — Einstellungen zeigen bei Manager den Manager-Baustein",
      "Welle 8 — ohne Manager gilt wieder die lokale Liste (Gegenprobe)",
      "Welle 8 — ohne Manager kein Manager-Baustein in den Einstellungen",
    ], r.grund ?? "ein echter llm-endpoint-manager ist geladen — nicht überschrieben");
    return;
  }
  try {
    const aufgeloest = await cdp.evaluate<string>(`return JSON.stringify(await ${PLUGIN}.effectiveEndpoints());`);
    const erwartet = JSON.stringify([{ url: "http://127.0.0.1:59999/v1", apiKey: "sk-smoke", model: "fake-modell" }]);
    record("Welle 8 — Lauf bekommt den Manager-Endpunkt samt Schlüssel und Modell", aufgeloest === erwartet, aufgeloest.replace(/sk-smoke/, "sk-…"));

    const mit = await einstellungenText(cdp);
    const zeigtBaustein = /kommen vom LLM Endpoint Manager|come from the LLM Endpoint Manager/i.test(mit.text);
    record("Welle 8 — Einstellungen zeigen bei Manager den Manager-Baustein", zeigtBaustein, zeigtBaustein ? "Hinweis „Endpunkte kommen vom …“ sichtbar" : "Hinweis fehlt");
    await cdp.evaluate(`app.setting.close(); return true;`);

    await entferneFakeManager(cdp);
    const lokal = await cdp.evaluate<string>(`return JSON.stringify(await ${PLUGIN}.effectiveEndpoints()) === JSON.stringify(${PLUGIN}.settings.endpoints) ? "gleich" : "abweichend";`);
    record("Welle 8 — ohne Manager gilt wieder die lokale Liste (Gegenprobe)", lokal === "gleich", lokal);
    const ohne = await einstellungenText(cdp);
    const baustein = /kommen vom LLM Endpoint Manager|come from the LLM Endpoint Manager/i.test(ohne.text);
    record("Welle 8 — ohne Manager kein Manager-Baustein in den Einstellungen", !baustein, baustein ? "Hinweis steht noch" : "Hinweis weg, lokale Liste da");
  } finally {
    // Abbau auch auf dem Abbruchpfad: der gesicherte Slot kommt zurück, ein eigener Fake wird nie stehen gelassen.
    await entferneFakeManager(cdp).catch(() => undefined);
    await cdp.evaluate(`app.setting.close(); return true;`).catch(() => undefined);
  }
}

/** Punkte 2 + 2d: ein Lauf, dessen Collector nichts findet, sagt das — in Notice, Protokoll und
 *  Panel — und ruft das Modell nicht auf. Der Fake-Server zaehlt jeden Chat-Aufruf. */
async function w8LeererCollector(cdp: Cdp): Promise<void> {
  const root = await cdp.evaluate<string>(`return ${PLUGIN}.settings.crewRoot.replace(/\\/+$/, "");`);
  const id = "zz-smoke-leer";
  const ordner = "zz-smoke-leerer-ordner";
  // Zentraler Stub (strenge Pfade, LM-Studio-404): `GET /v1/models` kennt ein Modell, jeder Chat-Aufruf steht im Zähler.
  const stub = await startLlmStub({ models: ["fake-modell"] });
  const port = stub.port;
  const chatCalls = (): number => stub.zaehler().chat;
  const posts = (): string[] => stub.anfragen().filter((x) => x.methode === "POST").map((x) => x.url);
  const team = ["---", "crew-kind: team", "name: ZZ Smoke leer", "version: 1", "description: Smoke", "trigger: manual",
    "limits:", "  max_writes: 1", "write_scope:", `  - "${ordner}/**/*.md"`, "tasks:",
    "  - id: collect", "    kind: collector", "    collector: vault.list", "    params:", `      folder: ${ordner}`,
    "  - id: analyse", "    kind: llm", "    agent: zz-smoke-agent", "    inputs: [collect]", "    instruction: Tue nichts.",
    "    output_schema: triage-v1", "    on_error: abort",
    "  - id: apply", "    kind: actions", "    inputs: [analyse]", "    allowed_actions: [frontmatter.patch]", "    allowed_keys: [priority]",
    "---", "Smoke", ""].join("\n");
  const agent = ["---", "crew-kind: agent", "name: ZZ Smoke", "---", "Du bist ein Test.", ""].join("\n");
  const teamPfad = `${root}/teams/${id}.md`;
  const agentPfad = `${root}/agents/zz-smoke-agent.md`;
  let runDir = "";
  try {
    await cdp.evaluate(`
      for (const d of [${JSON.stringify(root)}, ${JSON.stringify(root + "/teams")}, ${JSON.stringify(root + "/agents")}]) {
        if (!app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d);
      }
      await app.vault.create(${JSON.stringify(teamPfad)}, ${JSON.stringify(team)});
      await app.vault.create(${JSON.stringify(agentPfad)}, ${JSON.stringify(agent)});
      ${PLUGIN}.settings.endpoints = [{ url: "http://127.0.0.1:${port}/v1", model: "fake-modell" }];
      await ${PLUGIN}.refreshTeams?.();
      return true;
    `);
    // Der Orchestrator liest Team und Persona aus dem metadataCache, der nach dem Anlegen mit Verzug nachzieht: ein Lauf
    // direkt danach verweigert mit „Datei enthält einen Fehler“ (gemessen: Welle 8 war in jedem zweiten Lauf rot).
    await wartetAuf(cdp, `app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(teamPfad)}))?.frontmatter && app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(agentPfad)}))?.frontmatter`, 8000);
    await clearNotices(cdp);
    await cdp.evaluate(`${PLUGIN}.runCrew(${JSON.stringify(id)}); return true;`);
    const fertig = await wartetAuf(cdp, `${PLUGIN}.lastRuns[${JSON.stringify(id)}]`, 15000);
    record("Welle 8 — Lauf mit leerem Collector endet", fertig, fertig ? "lastRuns gesetzt" : "nach 15 s kein Ergebnis");
    if (!fertig) return;
    const info = await cdp.evaluate<{ runId: string; status: string; emptyCollector: string | null; writes: number }>(
      `return ${PLUGIN}.lastRuns[${JSON.stringify(id)}];`);
    runDir = `${root}/runs/${info.runId}`;
    record("Welle 8 — der leere Collector ist als Ursache im Ergebnis", info.emptyCollector === ordner && info.writes === 0,
      `emptyCollector=${info.emptyCollector}, writes=${info.writes}, status=${info.status}`);
    record("Welle 8 — kein Modellaufruf auf leerem Kontext", chatCalls() === 0, `Chat-Aufrufe am Fake-Server: ${chatCalls()} (POSTs insgesamt: ${posts().join(", ") || "keine"})`);

    const hinweis = await notices(cdp);
    const nennt = new RegExp(`${ordner}`).test(hinweis) && /0 passende Notizen|0 matching notes/.test(hinweis);
    record("Welle 8 — Notice nennt „0 Notizen“ und die Quelle statt „0 Dateien“", nennt, hinweis.slice(0, 140));
    const link = await cdp.evaluate<boolean>(`return Boolean(document.querySelector(".notice a.vault-crews-notice-link"));`);
    record("Welle 8 — Notice trägt den Link zum Protokoll", link, link ? "a.vault-crews-notice-link vorhanden" : "kein Link");
    const dir = process.env.SMOKE_SHOT_DIR;
    // Die Notice gleitet ein — eine Aufnahme im ersten Moment zeigt sie halb ausserhalb des Fensters.
    await new Promise((r) => setTimeout(r, 900));
    if (dir && link) writeFileSync(`${dir}/lauf-notice.png`, await capture(cdp));

    const geoeffnet = await cdp.evaluate<string>(`
      document.querySelector(".notice a.vault-crews-notice-link")?.click();
      await new Promise((r) => setTimeout(r, 900));
      return app.workspace.getActiveFile()?.path ?? "";
    `);
    record("Welle 8 — Klick auf den Link öffnet run.md dieses Laufs", geoeffnet === `${runDir}/run.md`, geoeffnet || "keine aktive Datei");
    const runMd = await cdp.evaluate<string>(`return await app.vault.adapter.read(${JSON.stringify(`${runDir}/run.md`)});`);
    record("Welle 8 — run.md nennt Quelle und übersprungenen Task", /Collector fand 0 passende Notizen in `zz-smoke-leerer-ordner`/.test(runMd) && /Übersprungen: Collector fand 0/.test(runMd),
      runMd.split("\n").filter((z) => /Collector fand|Übersprungen/.test(z)).join(" / ").slice(0, 160));

    await cdp.evaluate(`await ${PLUGIN}.activatePanel(); await new Promise((r) => setTimeout(r, 900)); return true;`);
    const panelText = await cdp.evaluate<string>(`return (${PANEL})?.innerText ?? "";`);
    const panelNennt = /0 passende Notizen in zz-smoke-leerer-ordner|0 matching notes in zz-smoke-leerer-ordner/.test(panelText);
    record("Welle 8 — Ergebnis-Karte nennt die leere Quelle", panelNennt, panelNennt ? "Nächste Handlung nennt die Quelle" : panelText.slice(0, 120).replace(/\n/g, " "));
    if (dir && panelNennt) writeFileSync(`${dir}/lauf-panel.png`, await capture(cdp));
    const zeile = await cdp.evaluate<string>(`
      const zurueck = [...((${PANEL})?.querySelectorAll("button") ?? [])].find((b) => /zurück zur übersicht|back to overview/i.test(b.textContent ?? ""));
      zurueck?.click();
      await new Promise((r) => setTimeout(r, 700));
      return (${PANEL})?.innerText ?? "";
    `);
    const zeileNennt = /0 passende Notizen in zz-smoke-leerer-ordner|0 matching notes in zz-smoke-leerer-ordner/.test(zeile);
    record("Welle 8 — Crew-Zeile im Panel nennt die leere Quelle", zeileNennt, zeileNennt ? "Statuszeile enthält die Quelle" : zeile.slice(0, 160).replace(/\n/g, " "));
    if (dir && zeileNennt) writeFileSync(`${dir}/lauf-zeile.png`, await capture(cdp));
  } finally {
    await stub.stop();
    await cdp.evaluate(`
      for (const p of [${JSON.stringify(teamPfad)}, ${JSON.stringify(agentPfad)}, ${JSON.stringify(runDir)}]) {
        if (!p) continue;
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      delete ${PLUGIN}.lastRuns[${JSON.stringify(id)}];
      return true;
    `).catch(() => undefined);
  }
}

/** Welle 11 — der Chat-Client (Kit `createChatClient`) im echten Obsidian, nicht gegen Mocks.
 *  Vier Punkte: (1) ein echtes Modell streamt, (2) ein Server, der den XHR wegen fehlender CORS-Kopfzeilen
 *  abweist, wird über den Fallback ohne Stream bedient, (3) der harte Gesamt-Timer meldet `timeout`,
 *  (4) der Stall-Detektor nach dem ersten Chunk meldet `stalled`. Punkt 1 braucht ein erreichbares Modell
 *  (LM Studio); fehlt es, ist der Punkt „nichts gemessen“, nie grün. Die Punkte 2–4 laufen gegen einen
 *  lokalen Fake-Server und brauchen kein Modell. Vorher UND nachher gefahren: der Umbau darf keinen
 *  der vier verändern (Baseline-Regel). */
/** Das einzige Modell, das der Punkt „echtes Modell“ anfragt (Modell-Runde Welle 22; per `--modell` ueberschreibbar). */
const MODELL_W11 = args.value("modell") ?? "google/gemma-4-e4b";

async function w11ChatClient(cdp: Cdp): Promise<void> {
  const saved = await cdp.evaluate<{ endpoints: unknown; call: number; stall: number }>(
    `return { endpoints: JSON.parse(JSON.stringify(${PLUGIN}.settings.endpoints)), call: ${PLUGIN}.settings.callTimeoutS, stall: ${PLUGIN}.settings.stallTimeoutS };`);
  try {
    // (1) echtes Modell — nicht awaiten (Cdp.send bricht nach 30 s ab, ein JIT-Laden dauert länger)
    // `--ohne-modell`: kein POST an :1234 (Wellen-Regel „kein Lauf lädt oder rechnet ein Modell“) → nichts gemessen.
    if (OHNE_MODELL) unmeasured(P_STREAM, "--ohne-modell (LM-Regel der Welle 20)");
    else await cdp.evaluate(`
      window.__vcW11 = { done: false };
      (async () => {
        try {
          // Das Modell ist ausdruecklich gesetzt, nie „das erste nicht-Embedding-Modell“: /v1/models listet auch NICHT geladene
          // Modelle, und eine Anfrage mit anderer ID laedt in LM Studio ein weiteres (JIT, Welle 22: ein Lauf hat so ein Modell geladen).
          ${PLUGIN}.settings.endpoints = [{ url: "http://localhost:1234", model: ${JSON.stringify(MODELL_W11)} }];   // echtes LM Studio, nicht der Fake der Vorpunkte
          const c = ${PLUGIN}.buildLlmClient();
          const ids = await c.listModels();
          const model = ids.includes(${JSON.stringify(MODELL_W11)}) ? ${JSON.stringify(MODELL_W11)} : null;
          if (!model) { window.__vcW11 = { done: true, skip: "Modell ${MODELL_W11} nicht am Endpunkt gelistet (" + ids.length + " Modelle)" }; return; }
          let calls = 0, text = "";
          const r = await c.stream([{ role: "user", content: "Zähle auf Deutsch von eins bis zehn, durch Kommas getrennt." }],
            { model, sentModel: model, params: { temperature: 0, max_tokens: 200 }, thinkingLevel: "off" },
            (t, isThink) => { if (!isThink) { calls++; text += t; } }, new AbortController().signal);
          window.__vcW11 = { done: true, model, calls, text, content: r.content, finish: r.finishReason };
        } catch (e) { window.__vcW11 = { done: true, skip: "Endpunkt nicht erreichbar: " + String(e?.message ?? e).slice(0, 120) }; }
      })();
      return true;
    `);
    const got = OHNE_MODELL ? null : await pollUntil<{ done: boolean; skip?: string; model?: string; calls?: number; text?: string; content?: string; finish?: string }>(
      cdp, `return window.__vcW11?.done ? window.__vcW11 : null;`, 240_000, 1_000).catch(() => null);
    if (OHNE_MODELL) { /* oben bereits als nichts gemessen geführt */ }
    else if (!got || got.skip) {
      unmeasured(P_STREAM, got?.skip ?? "keine Antwort in 240 s");
    } else {
      record(P_STREAM,
        (got.calls ?? 0) > 1 && (got.content ?? "").length > 0 && got.content === got.text && got.finish !== "aborted",
        `Modell ${String(got.model)} · ${String(got.calls)} Token-Aufrufe · finish=${String(got.finish)} · „${(got.content ?? "").slice(0, 50)}"`);
    }

    // (2)–(4) zentraler Stub. „Fallback“ ist ein Server OHNE CORS (`cors: false`: der Preflight bekommt 404, der XHR des
    // Renderers scheitert, `requestUrl` nicht); „schweigen“ und „stall“ sind Server mit CORS, die Antwort kommt aus dem Rückruf.
    const stub = await startLlmStub({ models: ["fake-modell"], cors: false, standard: "Fallback-Antwort" });
    const port = stub.port;
    const seen = (): { url: string; stream?: unknown }[] => stub.anfragen().filter((x) => x.route === "chat")
      .map((x) => ({ url: x.url, stream: (x.json as { stream?: unknown } | null)?.stream }));
    const versuch = (): Promise<{ ok: boolean; kind?: string; content?: string; finish?: string; ms: number; firstMs?: number; err?: string }> => cdp.evaluate(`
      ${PLUGIN}.settings.endpoints = [{ url: "http://127.0.0.1:${port}/v1", model: "fake-modell" }];
      ${PLUGIN}.settings.callTimeoutS = 3; ${PLUGIN}.settings.stallTimeoutS = 2;
      const c = ${PLUGIN}.buildLlmClient();
      const t0 = Date.now();
      let firstMs;
      try {
        const r = await c.stream([{ role: "user", content: "hi" }], { model: "fake-modell", sentModel: "fake-modell", params: { temperature: 0, max_tokens: 20 }, thinkingLevel: "off" }, () => { firstMs ??= Date.now() - t0; }, new AbortController().signal);
        return { ok: true, content: r.content, finish: r.finishReason, ms: Date.now() - t0, firstMs };
      } catch (e) { return { ok: false, kind: e?.kind, err: String(e?.message ?? e).slice(0, 120), ms: Date.now() - t0, firstMs }; }
    `);
    try {
      stub.konfiguriere({ cors: false }); stub.setzeAntwort(undefined);
      const f = await versuch();
      record(P_FALLBACK, f.ok && f.content === "Fallback-Antwort" && seen().length >= 1 && seen()[0]!.stream === false,
        f.ok ? `Antwort „${String(f.content)}" · Fake-Server sah stream=${String(seen()[0]?.stream)}` : `Fehler: ${String(f.err)}`);
      stub.konfiguriere({ cors: true }); stub.setzeAntwort(() => ({ stille: true }));
      const t = await versuch();
      record(P_TIMEOUT, !t.ok && t.kind === "timeout" && t.ms >= 2500 && t.ms < 8000, `kind=${String(t.kind)} nach ${t.ms} ms (Soll 3000)`);
      stub.setzeAntwort(() => ({ stuecke: ["Anfang"], haengtNach: 1 }));
      const st = await versuch();
      record(P_STALL, !st.ok && st.kind === "stalled" && st.ms >= 1500 && st.ms < 8000, `kind=${String(st.kind)} nach ${st.ms} ms, erster Chunk nach ${String(st.firstMs)} ms (Soll: Stall 2000 ms nach dem Chunk)`);
    } finally {
      await stub.stop();
    }
  } finally {
    await cdp.evaluate(`
      ${PLUGIN}.settings.endpoints = ${JSON.stringify(saved.endpoints)};
      ${PLUGIN}.settings.callTimeoutS = ${saved.call}; ${PLUGIN}.settings.stallTimeoutS = ${saved.stall};
      delete window.__vcW11; return true;
    `).catch(() => undefined);
  }
}

/** Welle 14 — was ein Lauf mit dem Modell schickt (Modus structured), gemessen AM DRAHT.
 *  Die Kette ist die echte — Lauf → Orchestrator → RequestPort (Familie aus dem Namen, Backend-Probe) →
 *  `buildCrewParams` → Kit-Client → XHR —; nur der Endpunkt ist ein Fake-Server, der jeden gesendeten
 *  Body festhält. `lastRequest()` der Sitzung zeigt, was das Plugin zu senden GLAUBT, nicht was ankam. */
async function w14Body(cdp: Cdp): Promise<void> {
  const root = await cdp.evaluate<string>(`return ${PLUGIN}.settings.crewRoot.replace(/\\/+$/, "");`);
  const modell = "qwen/qwen3.8-27b";
  const id = "zz-w14";
  const ordner = "zz-w14-ordner";
  // Zentraler Stub mit CORS (Default an): der Stream-Weg (XHR) läuft im Renderer und braucht Preflight und Kopfzeilen —
  // ohne sie weicht der Client auf den Fallback ohne Stream (`stream:false`) aus, und der Punkt misst den Ausweichweg.
  const stub = await startLlmStub({ models: [modell], standard: '{"items":[]}' });
  const port = stub.port;
  /** Die Bodies aller Chat-Anfragen am Draht, in der Reihenfolge ihres Eintreffens. */
  const bodies = (): Array<Record<string, unknown>> => stub.anfragen().filter((x) => x.route === "chat")
    .map((x) => (x.json as Record<string, unknown> | null) ?? { _unparseable: x.body });
  const team = ["---", "crew-kind: team", "name: ZZ W14", "version: 1", "description: Smoke", "trigger: manual",
    "limits:", "  max_writes: 1", "write_scope:", `  - "${ordner}/**/*.md"`, "tasks:",
    "  - id: collect", "    kind: collector", "    collector: vault.list", "    params:", `      folder: ${ordner}`,
    "  - id: analyse", "    kind: llm", "    agent: zz-w14-agent", "    inputs: [collect]", "    instruction: Tue nichts.",
    "    output_schema: triage-v1", "    on_error: skip",
    "  - id: apply", "    kind: actions", "    inputs: [analyse]", "    allowed_actions: [frontmatter.patch]", "    allowed_keys: [priority]",
    "---", "Smoke", ""].join("\n");
  const agentMd = (extra: string[]): string => ["---", "crew-kind: agent", "name: ZZ W14", ...extra, "---", "Du bist ein Test.", ""].join("\n");
  const teamPfad = `${root}/teams/${id}.md`;
  const agentPfad = `${root}/agents/zz-w14-agent.md`;
  const notePfad = `${ordner}/a.md`;
  let runDir = "";
  /** Ein Lauf mit gegebener Persona und (optional) Überschreibung des Plugins; liefert den ERSTEN Body dieses Laufs. */
  const fahre = async (agentZeilen: string[], ueberschreibung: number | null): Promise<Record<string, unknown> | undefined> => {
    const vorher = bodies().length;
    await cdp.evaluate(`await app.vault.adapter.write(${JSON.stringify(agentPfad)}, ${JSON.stringify(agentMd(agentZeilen))}); return true;`);
    // Der Orchestrator liest die Persona aus dem metadataCache, und der zieht nach einem Schreiben mit Verzug nach:
    // ein Lauf direkt nach dem Schreiben rechnete sonst mit der VORIGEN Persona (gemessen: N2-3/N2-4 lasen jeweils die
    // Werte des Vorlaufs). Also erst starten, wenn der Cache die neue Persona trägt — Schlüssel für Schlüssel.
    const erwartet = Object.fromEntries(agentZeilen.map((z) => z.split(": ") as [string, string]));
    const gezogen = await pollUntil<boolean>(cdp, `
      const f = app.vault.getAbstractFileByPath(${JSON.stringify(agentPfad)});
      const fm = (f && app.metadataCache.getFileCache(f)?.frontmatter) ?? null;
      if (!fm) return null;
      const erw = ${JSON.stringify(erwartet)};
      for (const k of ["temperature", "max_tokens", "thinking"]) {
        if (k in erw ? String(fm[k]) !== erw[k] : fm[k] !== undefined) return null;
      }
      return true;`, 10_000, 200).catch(() => null);
    if (!gezogen) console.log("    (metadataCache trägt die neue Persona nach 10 s nicht — der Punkt misst vermutlich die vorige)");
    await cdp.evaluate(`
      ${PLUGIN}.settings.request = ${JSON.stringify(ueberschreibung === null
        ? { overrides: {}, thinking: {}, lastOnLevel: {}, levelPickerInChat: false }
        : { overrides: { structured: { "qwen3.8": { temperature: ueberschreibung } } }, thinking: {}, lastOnLevel: {}, levelPickerInChat: false })};
      delete ${PLUGIN}.lastRuns[${JSON.stringify(id)}];
      ${PLUGIN}.runCrew(${JSON.stringify(id)});
      return true;`);
    // Fertig heißt: Ergebnis gesetzt UND der Ein-Lauf-Mutex wieder frei — sonst weist der nächste `runCrew` ab
    // („Ein Lauf ist aktiv"), und der Punkt läse den Body des Vorlaufs.
    const fertig = await wartetAuf(cdp, `${PLUGIN}.lastRuns[${JSON.stringify(id)}] && ${PLUGIN}.runActive === false`, 20000);
    if (fertig) {
      const info = await cdp.evaluate<{ runId: string }>(`return ${PLUGIN}.lastRuns[${JSON.stringify(id)}];`);
      runDir = `${root}/runs/${info.runId}`;
    }
    console.log(`    (Lauf: ${fertig ? "fertig" : "KEIN Ergebnis"}, ${bodies().length - vorher} Body/Bodies am Fake-Server)`);
    return bodies().length > vorher ? bodies()[vorher] : undefined;
  };
  const saved = await cdp.evaluate<{ endpoints: unknown; request: unknown }>(
    `return { endpoints: JSON.parse(JSON.stringify(${PLUGIN}.settings.endpoints)), request: JSON.parse(JSON.stringify(${PLUGIN}.settings.request)) };`);
  try {
    await cdp.evaluate(`
      for (const d of [${JSON.stringify(root)}, ${JSON.stringify(root + "/teams")}, ${JSON.stringify(root + "/agents")}, ${JSON.stringify(ordner)}]) {
        if (!app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d);
      }
      await app.vault.create(${JSON.stringify(teamPfad)}, ${JSON.stringify(team)});
      await app.vault.create(${JSON.stringify(agentPfad)}, ${JSON.stringify(agentMd([]))});
      await app.vault.create(${JSON.stringify(notePfad)}, "---\\npriority: mittel\\n---\\nInhalt\\n");
      ${PLUGIN}.settings.endpoints = [{ url: "http://127.0.0.1:${port}/v1", model: ${JSON.stringify(modell)} }];
      await ${PLUGIN}.refreshTeams?.();
      return true;`);
    // --- N2-1: ohne Persona-Werte und ohne Überschreibung: Profilwerte am Draht ------------------
    const b1 = await fahre([], null);
    record("N2-1 Body am Draht trägt Profilwerte (qwen3.8, Modus structured)",
      b1 !== undefined && b1.model === modell && b1.stream === true && b1.temperature === 0.1 && b1.top_p === 0.8
        && b1.reasoning_effort === "none" && b1.max_tokens === 2048 && !("top_k" in b1),
      b1 ? `model ${String(b1.model)}, stream ${String(b1.stream)}, temperature ${String(b1.temperature)}, top_p ${String(b1.top_p)}, reasoning_effort ${String(b1.reasoning_effort)}, max_tokens ${String(b1.max_tokens)}, top_k ${"top_k" in b1 ? "DA" : "weg"}` : "kein Request angekommen");
    // --- N2-2: die Überschreibung des Plugins kommt an (Gegenprobe zu N2-1) ----------------------
    const b2 = await fahre([], 0.3);
    record("N2-2 Überschreibung des Plugins ändert den Body (Gegenprobe zu N2-1)", b2 !== undefined && b2.temperature === 0.3,
      b2 ? `temperature ${String(b2.temperature)} (Plugin-Überschreibung 0.3, Profil 0.1)` : "kein Request angekommen");
    // --- N2-3: die Persona steht darüber — Temperatur UND Budget ---------------------------------
    const b3 = await fahre(["temperature: 0.4", "max_tokens: 1500"], 0.3);
    record("N2-3 Persona schlägt Überschreibung und Profil (Temperatur 0.4 statt 0.3, Budget 1500)", b3 !== undefined && b3.temperature === 0.4 && b3.max_tokens === 1500,
      b3 ? `temperature ${String(b3.temperature)}, max_tokens ${String(b3.max_tokens)}` : "kein Request angekommen");
    // --- N2-4: thinking: on → fest medium; Budget auf die Reserve der Familie --------------------
    const b4 = await fahre(["thinking: on"], null);
    record("N2-4 thinking: on in der Persona sendet die Stufe medium und hebt das Budget (Reserve der Familie)",
      b4 !== undefined && b4.reasoning_effort === "medium" && typeof b4.max_tokens === "number" && b4.max_tokens >= 2048 && b4.top_p === 0.95,
      b4 ? `reasoning_effort ${String(b4.reasoning_effort)}, max_tokens ${String(b4.max_tokens)}, top_p ${String(b4.top_p)}` : "kein Request angekommen");
    const letzte = await cdp.evaluate<Record<string, unknown> | null>(`
      const l = ${PLUGIN}.requestSession.lastRequest();
      return l ? l.params : null;`);
    record("N2-5 Die Sitzung zeigt, was wirklich gesendet wurde (letzte Anfrage = Body des vierten Laufs)",
      letzte !== null && b4 !== undefined && ["temperature", "top_p", "reasoning_effort", "max_tokens"].every((k) => letzte[k] === b4[k]),
      letzte ? `Sitzung: temperature ${String(letzte.temperature)}, reasoning_effort ${String(letzte.reasoning_effort)}` : "keine Aufzeichnung");
  } finally {
    await stub.stop();
    await cdp.evaluate(`
      ${PLUGIN}.settings.endpoints = ${JSON.stringify(saved.endpoints)};
      ${PLUGIN}.settings.request = ${JSON.stringify(saved.request)};
      for (const p of [${JSON.stringify(teamPfad)}, ${JSON.stringify(agentPfad)}, ${JSON.stringify(notePfad)}, ${JSON.stringify(ordner)}, ${JSON.stringify(runDir)}]) {
        if (!p) continue;
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      delete ${PLUGIN}.lastRuns[${JSON.stringify(id)}];
      return true;`).catch(() => undefined);
  }
}

/** N1: der Abschnitt „Request" in den Einstellungen — Öffnen des Tabs NACH N2 (also auch der Beleg, dass der Tab die
 *  Sitzung neu liest: „Letzte Anfrage" steht da), dann zwei Bearbeitungen hintereinander (Überschreiben, Zurücksetzen):
 *  der Abschnitt darf dazwischen nicht zuklappen. Zwei Sprachen, deshalb Muster und `data-field` statt Literale. */
async function w14Abschnitt(cdp: Cdp): Promise<void> {
  const ui = await einstellungenOeffnen(cdp);
  if (!ui) { unmeasured(N1_PUNKT, "kein Einstellungen-Fenster am Port (gilt auch für N1-2 bis N1-4)"); return; }
  const kopf = `
    const wurzel = document.querySelector(".modal.mod-settings") ?? document.body;
    const kopf = [...wurzel.querySelectorAll(".okit-collapsible-header")].find((h) => /^(Request|Anfrage)$/.test(h.textContent.trim()));
    const koerper = kopf ? kopf.nextElementSibling : null;`;
  try {
    const offen = await ui.evaluate<{ gefunden: boolean; offen: boolean }>(`
      ${kopf}
      if (!kopf) return { gefunden: false, offen: false };
      if (koerper.classList.contains("is-collapsed")) kopf.click();
      await new Promise((r) => setTimeout(r, 400));
      return { gefunden: true, offen: !koerper.classList.contains("is-collapsed") };`);
    if (!offen.gefunden) { record(N1_PUNKT, false, "Kopf „Request/Anfrage“ fehlt in den Einstellungen"); return; }
    const inhalt = await ui.evaluate<{ felder: string[]; letzte: string | null; hinweis: boolean }>(`
      ${kopf}
      return {
        felder: [...koerper.querySelectorAll("input[data-field]")].map((i) => i.dataset.field),
        letzte: koerper.querySelector("pre.okit-request-last")?.textContent ?? null,
        hinweis: /temperature|max_tokens|thinking/.test(koerper.parentElement?.textContent ?? ""),
      };`);
    const fehlt = ["temperature", "top_p", "max_tokens"].filter((f) => !inhalt.felder.includes(f));
    record(N1_PUNKT, offen.offen && fehlt.length === 0,
      fehlt.length === 0 ? `${inhalt.felder.length} Felder (${inhalt.felder.join(", ")})` : `fehlt: ${fehlt.join(", ")}`);
    record("N1-2 „Letzte Anfrage“ trägt die Anfrage aus N2 (Tab liest die Sitzung beim Öffnen neu)",
      inhalt.letzte !== null && inhalt.letzte.includes('"temperature"') && inhalt.letzte.includes('"max_tokens"'),
      inhalt.letzte !== null ? inhalt.letzte.replace(/\s+/g, " ").slice(0, 90) : "keine Aufzeichnung im Abschnitt");
    record("N1-3 Der Persona-Hinweis steht im Abschnitt", inhalt.hinweis, inhalt.hinweis ? "Hinweistext nennt temperature/max_tokens/thinking" : "kein Hinweis");

    const setzen = await ui.evaluate<boolean>(`
      ${kopf}
      const inp = koerper.querySelector('input[data-field="temperature"]');
      if (!inp) return false;
      inp.focus(); inp.value = "0.3"; inp.dispatchEvent(new Event("blur"));
      return true;`);
    const nachSetzen = setzen ? await pollUntil<{ offen: boolean }>(ui, `
      ${kopf}
      const inp = koerper?.querySelector('input[data-field="temperature"]');
      if (!inp || !inp.classList.contains("okit-request-own")) return null;
      return { offen: !koerper.classList.contains("is-collapsed") };`, 8_000, 300).catch(() => null) : null;
    const zurueck = nachSetzen ? await ui.evaluate<boolean>(`
      ${kopf}
      const zeile = koerper.querySelector('input[data-field="temperature"]').closest(".setting-item");
      const knopf = [...zeile.querySelectorAll("[aria-label]")].find((k) => /^(Reset|Zurücksetzen)$/.test(k.getAttribute("aria-label")));
      if (!knopf) return false;
      knopf.click();
      return true;`) : false;
    const nachReset = zurueck ? await pollUntil<{ offen: boolean; leer: boolean }>(ui, `
      ${kopf}
      const inp = koerper?.querySelector('input[data-field="temperature"]');
      if (!inp || inp.classList.contains("okit-request-own")) return null;
      return { offen: !koerper.classList.contains("is-collapsed"), leer: inp.value === "" };`, 8_000, 300).catch(() => null) : null;
    const gespeichert = await cdp.evaluate<string>(`return JSON.stringify(${PLUGIN}.settings.request.overrides);`);
    record("N1-4 Überschreiben und Zurücksetzen nacheinander: Abschnitt bleibt offen, Wert wird gespeichert und wieder gelöscht",
      Boolean(nachSetzen?.offen) && Boolean(nachReset?.offen) && Boolean(nachReset?.leer) && gespeichert === "{}",
      !setzen ? "Temperatur-Feld nicht gefunden"
        : !nachSetzen ? "Überschreibung kam nicht an (Feld nicht als eigen markiert)"
        : !zurueck ? "Zurücksetzen-Knopf fehlt"
        : !nachReset ? "Zurücksetzen griff nicht"
        : `nach Überschreiben ${nachSetzen.offen ? "offen" : "ZU"}, nach Zurücksetzen ${nachReset.offen ? "offen" : "ZU"}, gespeichert ${gespeichert}`);
  } finally {
    await cdp.evaluate(`
      if (${PLUGIN}.settings.request?.overrides?.structured) { delete ${PLUGIN}.settings.request.overrides.structured; }
      return true;`).catch(() => undefined);
    await cdp.evaluate(`app.setting.close(); return true;`).catch(() => undefined);
  }
}

async function abschnittWelle14(cdp: Cdp): Promise<void> {
  try {
    await w14Body(cdp);
    await w14Abschnitt(cdp);
    record("Welle 14 — Abschnitt lief bis zum Ende", true, "kein Abbruch");
  } catch (e) {
    if (e instanceof AbbruchAusnahme || istAbgebrochen()) throw e;   // ein Abbruch ist kein Befund und wird nicht als „rot“ verbucht
    record("Welle 14 — Abschnitt lief bis zum Ende", false, `abgebrochen: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Welle 20: der Strom im Panel, gemessen gegen den zentralen Stub ---------------------------------------------

const P_ABBRECHEN = "Panel — Abbrechen-Knopf liegt während eines Laufs im Leaf-Rechteck";

/** Startet den Lauf und wartet, bis der Strombereich steht: mindestens 900 ms seit dem Start, dasselbe Element 300 ms lang und
 *  schon Text darin. Gemessen 2026-10-14 (Elementwechsel von `.okit-stream-body` nach dem Start, zwei Läufe): das Panel
 *  zeichnet den Bereich in den ersten 0,42 s dreimal neu (bei etwa 12, 15 und 416 ms, bei 19 bis 340 Zeichen „Warte auf Ausgabe …“
 *  bzw. den ersten Stücken), danach bis zum Schluss-Draw nicht mehr. Ein Beobachter, der vor dem dritten Wechsel hängt, bekäme
 *  ihn als Neuaufbau und wäre „nichts gemessen“ (so geschehen: Absatz-Strom, dritter Wechsel 100 ms nach der Stabilitätsbedingung).
 *  Ein Wechsel im Strom selbst bliebe ein Befund. Dieser Workaround entfällt, wenn `messeFolge` einen Elementwechsel VOR „bereit“
 *  (Überlauf ≥ 80 px) als Anlauf wertet und das Element neu bindet (Entscheidung des Masters 2026-10-14, Task für Welle 22 im
 *  Dach-Cockpit; kuro-gamification hatte denselben Fall). */
async function starteLaufUndWarteAufBereich(cdp: Cdp, id: string): Promise<void> {
  await cdp.evaluate(`window.__vcBereich = { el: null, t: 0, start: performance.now() }; ${PLUGIN}.runCrew(${JSON.stringify(id)}); return true;`);
  await pollUntil<boolean>(cdp, `
    const el = ${PANEL}.querySelector(".okit-stream-body");
    const w = window.__vcBereich;
    const jetzt = performance.now();
    if (!el) { w.el = null; return null; }
    if (w.el !== el) { w.el = el; w.t = jetzt; return null; }
    return jetzt - w.t >= 300 && jetzt - w.start >= 900 && (el.textContent || "").length > 40 ? true : null;`, 15_000, 100);
}

/** Welle 20 — die vier Punkte, die ohne Modell nie messbar waren (Dach-Task „Stream-Stub für GUI-Smokes“):
 *  (1) der Abbrechen-Knopf der Statuszeile liegt WÄHREND eines Laufs im Rechteck des Leaf (UI-STANDARD §4),
 *  (2) Denkblock live: der Denktext wächst während des Stroms und die Zusammenfassungszeile zählt mit,
 *  (3) Folge-Regel: ein Hochscrollen mitten im Strom wird respektiert, (4) Kontrolle: ohne Störung folgt der Strom.
 *
 *  Vorlauf-Check zur Folge-Regel: `buildStreamArea` bekommt hier kein `scrollEl`, also scrollt `.okit-stream-body`
 *  selbst, und seine Höhe ist begrenzt (`max-height: 40vh`, styles.css) — der Bereich kann also überlaufen und folgen.
 *  Gültigkeitsbedingung (sonst „nichts gemessen“, CORE-TEST-22): der Überlauf beträgt zum Störungszeitpunkt ≥ 80 px
 *  (Schwelle `followThreshold` 40 px plus 40 px Spielraum), und nach der Störung kommen mindestens zwei weitere Stücke.
 *  Gemessen wird `scrollTop` nach der Störung gegen `scrollTop` zur Störungszeit, nicht die Schwelle als Position; der
 *  Stub hält die Verbindung nach dem letzten Stück offen (`nachlaufMs`), Messungen nach dem Schluss-Draw zählen nicht. */
async function w20Lauf(cdp: Cdp): Promise<void> {
  const root = await cdp.evaluate<string>(`return ${PLUGIN}.settings.crewRoot.replace(/\\/+$/, "");`);
  const id = "zz-w20";
  const ordner = "zz-w20-ordner";
  // Tokengroße Stücke (≤ 10 Zeichen, Rundschreiben 3): `followTail` prüft „am Ende?“ NACH dem Wachsen — ein Stück, das den
  // Text um mehr als die Schwelle (40 px) vergrößert, sähe wie ein Hochscrollen aus und beendete das Folgen (Kit-Befund,
  // Welle 20; mit 90-Zeichen-Stücken war die Kontrolle auf dem Pin 0.57.0 rot: Abstand 79 px — erwartet, Fix in obsidian-kit
  // 0.59.0). Mit absatzgroßen Stücken gehört die Kontrolle nach der Pin-Hebung (B2) dazu, sonst misst sie die Stückgröße.
  const TAKT = 40;
  const zeilen = (praefix: string, n: number): string =>
    Array.from({ length: n }, (_, i) => `${praefix} ${String(i + 1).padStart(2, "0")} — ein Satz, der Platz im Strom braucht.\n`).join("");
  const text = zeilen("Zeile", 60);   // lang genug für drei Phasen (Kontrolle, Störung, Wiederaufnahme); der Hebel ist die Stublänge, nie die Schwelle
  const stub = await startLlmStub({
    models: ["fake-modell"], takt: TAKT, laenge: 10, nachlaufMs: 4 * TAKT,
    standard: { reasoning: zeilen("Denkzeile", 12), text },
  });
  const team = ["---", "crew-kind: team", "name: ZZ W20", "version: 1", "description: Smoke", "trigger: manual",
    "limits:", "  max_writes: 1", "write_scope:", `  - "${ordner}/**/*.md"`, "tasks:",
    "  - id: collect", "    kind: collector", "    collector: vault.list", "    params:", `      folder: ${ordner}`,
    "  - id: analyse", "    kind: llm", "    agent: zz-w20-agent", "    inputs: [collect]", "    instruction: Tue nichts.",
    "    output_schema: triage-v1", "    on_error: skip",
    "  - id: apply", "    kind: actions", "    inputs: [analyse]", "    allowed_actions: [frontmatter.patch]", "    allowed_keys: [priority]",
    "---", "Smoke", ""].join("\n");
  const agent = ["---", "crew-kind: agent", "name: ZZ W20", "---", "Du bist ein Test.", ""].join("\n");
  const teamPfad = `${root}/teams/${id}.md`;
  const agentPfad = `${root}/agents/zz-w20-agent.md`;
  const notePfad = `${ordner}/a.md`;
  const saved = await cdp.evaluate<{ endpoints: unknown }>(`return { endpoints: JSON.parse(JSON.stringify(${PLUGIN}.settings.endpoints)) };`);
  let runDir = "";
  try {
    await cdp.evaluate(`
      for (const d of [${JSON.stringify(root)}, ${JSON.stringify(root + "/teams")}, ${JSON.stringify(root + "/agents")}, ${JSON.stringify(ordner)}]) {
        if (!app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d);
      }
      await app.vault.create(${JSON.stringify(teamPfad)}, ${JSON.stringify(team)});
      await app.vault.create(${JSON.stringify(agentPfad)}, ${JSON.stringify(agent)});
      await app.vault.create(${JSON.stringify(notePfad)}, "---\\npriority: mittel\\n---\\nInhalt\\n");
      ${PLUGIN}.settings.endpoints = [{ url: "${stub.urlV1}", model: "fake-modell" }];
      await ${PLUGIN}.refreshTeams?.();
      await ${PLUGIN}.activatePanel();
      return true;`);
    await wartetAuf(cdp, `app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(teamPfad)}))?.frontmatter && app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(agentPfad)}))?.frontmatter`, 8000);
    // Das Crews-Panel muss der aktive Tab sein (der Fast-Path zeichnet nur dort).
    await cdp.evaluate(`${PANEL}.querySelector('.okit-hub-tab[data-tab="crews"]')?.click(); await new Promise((r) => setTimeout(r, 300)); return true;`);

    // Abbrechen-Knopf und Denkblock misst die Schleife im Renderer (eine CDP-Rundreise je Sample wäre selbst ein Takt); die
    // Folge-Regel misst `messeFolge` der Brücke im selben Strom. Die Schleife stört den Bereich nicht (kein `scrollTop`).
    await cdp.evaluate(`
      window.__vcW20 = { fertig: false };
      (async () => {
        const w = window.__vcW20;
        const leaf = ${PANEL};
        const warte = (ms) => new Promise((r) => setTimeout(r, ms));
        w.ikonen = [];
        w.denk = []; w.summary = []; w.cancel = null; w.kontrolle = null; w.gestartet = false;
        const t0 = Date.now();
        while (Date.now() - t0 < 60000) {
          if (${PLUGIN}.runActive === true) w.gestartet = true;
          if (w.gestartet && ${PLUGIN}.runActive === false) break;
          if (${PLUGIN}.runActive === true) {
            for (const ik of leaf.querySelectorAll(".vault-crews-task-icon")) {
              const svg = ik.querySelector("svg");
              const probe = { cls: [...ik.classList].filter((c) => c.startsWith("is-")).join(" "), aria: ik.getAttribute("aria-label") ?? "",
                svg: svg !== null, anim: svg ? getComputedStyle(svg).animationName : "", farbe: getComputedStyle(ik).color };
              if (!w.ikonen.some((x) => x.cls === probe.cls && x.aria === probe.aria && x.anim === probe.anim)) w.ikonen.push(probe);
            }
          }
          const body = leaf.querySelector(".okit-stream-body");
          const pre = leaf.querySelector(".okit-stream-reasoning pre");
          const sum = leaf.querySelector(".okit-stream-reasoning summary");
          if (pre && ${PLUGIN}.runActive === true) {
            const n = pre.textContent.length;
            if (w.denk[w.denk.length - 1] !== n) { w.denk.push(n); w.summary.push(sum ? sum.textContent : ""); }
          }
          if (body && w.cancel === null && body.scrollHeight - body.clientHeight >= 80) {
            w.kontrolle = { ueberlauf: body.scrollHeight - body.clientHeight };
            // Abbrechen-Knopf im Leaf-Rechteck, jetzt, wo der Inhalt groß ist
            const knopf = leaf.querySelector(".vault-crews-cancel");
            if (knopf) {
              const k = knopf.getBoundingClientRect(), l = leaf.getBoundingClientRect();
              w.cancel = { k: [k.left, k.top, k.right, k.bottom].map(Math.round), l: [l.left, l.top, l.right, l.bottom].map(Math.round),
                sichtbar: k.width > 0 && k.height > 0 };
            } else { w.cancel = { fehlt: true }; }
          }
          await warte(40);
        }
        w.fertig = true;
      })();
      return true;`);
    let fehlerFolge = "";
    if (FOLGE_GEGENPROBE) {
      await cdp.evaluate(`
        window.__vcGegenprobe?.disconnect();
        window.__vcGegenprobe = new MutationObserver(() => {
          const el = ${PANEL}?.querySelector(".okit-stream-body");
          if (el) el.scrollTop = el.scrollHeight;
        });
        window.__vcGegenprobe.observe(document.body, { childList: true, characterData: true, subtree: true });
        return true;`);
    }
    await starteLaufUndWarteAufBereich(cdp, id);
    const folge = await messeFolge(cdp, {
      ausdruck: `${PANEL}.querySelector(".okit-stream-body")`,
      laeuft: () => cdp.evaluate<boolean>(`return ${PLUGIN}.runActive === true;`),
      wiederaufnahme: true,
    }).catch((e: unknown) => { fehlerFolge = e instanceof Error ? e.message : String(e); return null; });
    const w = await pollUntil<{
      gestartet: boolean;
      denk: number[]; summary: string[];
      ikonen: { cls: string; aria: string; svg: boolean; anim: string; farbe: string }[];
      kontrolle: { ueberlauf: number } | null;
      cancel: { k?: number[]; l?: number[]; sichtbar?: boolean; fehlt?: boolean } | null;
    }>(cdp, `return window.__vcW20?.fertig ? window.__vcW20 : null;`, 70_000, 500).catch(() => null);
    const fertig = await wartetAuf(cdp, `${PLUGIN}.lastRuns[${JSON.stringify(id)}] && ${PLUGIN}.runActive === false`, 20000);
    if (fertig) {
      const info = await cdp.evaluate<{ runId: string }>(`return ${PLUGIN}.lastRuns[${JSON.stringify(id)}];`);
      runDir = `${root}/runs/${info.runId}`;
    }
    const keinLauf = "kein Lauf zustande gekommen (Messschleife lieferte nichts)";

    // (1) Abbrechen-Knopf im Leaf-Rechteck
    if (!w || !w.gestartet || w.cancel === null) unmeasured(P_ABBRECHEN, w ? "der Lauf startete nicht oder der Strom blieb zu kurz" : keinLauf);
    else if (w.cancel.fehlt) record(P_ABBRECHEN, false, "kein .vault-crews-cancel während des Laufs");
    else {
      const [kl, kt, kr, kb] = w.cancel.k ?? [0, 0, 0, 0];
      const [ll, lt, lr, lb] = w.cancel.l ?? [0, 0, 0, 0];
      const innen = (w.cancel.sichtbar ?? false) && kl >= ll - 1 && kt >= lt - 1 && kr <= lr + 1 && kb <= lb + 1;
      record(P_ABBRECHEN, innen, `Knopf [${kl},${kt},${kr},${kb}] im Leaf [${ll},${lt},${lr},${lb}] bei Überlauf ${String(w.kontrolle?.ueberlauf)} px`);
    }

    // (2) Denkblock live: wächst, Zusammenfassung zählt mit. Gültig erst ab drei Samples während des Laufs.
    if (!w || w.denk.length < 3) unmeasured(P_DENKBLOCK, w ? `nur ${w.denk.length} Sample(s) des Denktexts während des Laufs` : keinLauf);
    else {
      const waechst = w.denk.every((n, i) => i === 0 || n > (w.denk[i - 1] ?? 0));
      const zahl = (z: string | undefined): number => Number((z ?? "").match(/\d+/)?.[0] ?? NaN);
      // Der Zähler hält mit den Stücken Schritt: schon beim ersten Stück ≥ 1, am Ende nicht hinter den gesehenen Stücken.
      // (Ein bloßes „wächst“ bestünde auch ohne den Fast-Path: jede volle Neuzeichnung schriebe den Stand nach.)
      const zaehlt = zahl(w.summary[0]) >= 1 && zahl(w.summary[w.summary.length - 1]) >= w.denk.length - 2;
      record(P_DENKBLOCK, waechst && zaehlt,
        `${w.denk.length} Samples, Denktext ${w.denk[0]} → ${w.denk[w.denk.length - 1]} Zeichen · Zusammenfassung „${String(w.summary[0])}“ → „${String(w.summary[w.summary.length - 1])}“`);
    }

    // (2b) Status-Symbole der Aufgabenzeilen (Welle 23): während des Laufs steht mindestens ein Symbol im Zustand „läuft“ mit
    // Icon, Zustandsklasse `is-checking`, Textalternative „Running“ UND laufender Animation (die Klasse steht auch ohne die
    // CSS-Regel da, UI-STANDARD §8: nur `getComputedStyle(svg).animationName` belegt die Bewegung). Ein Endzustand darf stillstehen.
    if (!w || w.ikonen.length === 0) unmeasured(P_STATUSSYMBOLE, w ? "kein .vault-crews-task-icon während des Laufs gesehen" : keinLauf);
    else {
      const lauf = w.ikonen.find((x) => x.cls === "is-checking");
      const ok = lauf !== undefined && lauf.svg && lauf.aria === "Running" && lauf.anim !== "none" && lauf.anim !== "";
      const alle = w.ikonen.every((x) => x.svg && x.aria !== "");
      const farben = new Set(w.ikonen.map((x) => x.farbe)).size;
      record(P_STATUSSYMBOLE, ok && alle,
        `${w.ikonen.length} Zustände gesehen: ${w.ikonen.map((x) => `[${x.cls || "–"} „${x.aria}“ anim=${x.anim} ${x.farbe}]`).join(" ")} · ${farben} Farbe(n)`);
    }

    // (3)/(4)/(5) Folge-Regel: Kontrolle, Störung, Wiederaufnahme. Ungültige Messung ist „nichts gemessen“ (CORE-TEST-22).
    if (folge === null) {
      for (const n of [P_KONTROLLE, P_FOLGE, P_WIEDERAUFNAHME] as const) unmeasured(n, `Folge-Messung nicht zustande gekommen: ${fehlerFolge || keinLauf}`);
    } else {
      zeichneFolge(bilanz, { kontrolle: P_KONTROLLE, folge: P_FOLGE, wiederaufnahme: P_WIEDERAUFNAHME }, folge);
    }
  } finally {
    await stub.stop();
    await cdp.evaluate(`
      ${PLUGIN}.settings.endpoints = ${JSON.stringify(saved.endpoints)};
      for (const p of [${JSON.stringify(teamPfad)}, ${JSON.stringify(agentPfad)}, ${JSON.stringify(notePfad)}, ${JSON.stringify(ordner)}, ${JSON.stringify(runDir)}]) {
        if (!p) continue;
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      delete ${PLUGIN}.lastRuns[${JSON.stringify(id)}];
      delete window.__vcW20;
      window.__vcGegenprobe?.disconnect(); delete window.__vcGegenprobe;
      return true;`).catch(() => undefined);
  }
}

/** Kontrolle der Folge-Regel mit ABSATZGROSSEN Stücken (Rundschreiben 3/4): jedes Stück ist drei Zeilen hoch, also deutlich
 *  über der Folge-Schwelle (40 px). Vor obsidian-kit 0.59.0 maß `followTail` „unten?“ erst NACH dem Wachsen und hörte nach
 *  dem ersten solchen Stück auf zu folgen (Befund kuro-w20) — auf dem Pin 0.57.0 ist dieser Punkt deshalb ROT (erwartet),
 *  ab 0.59.0 grün: er belegt, dass der Kit-Fix im Plugin ankommt. Gültig erst, wenn der Überlauf ≥ 80 px erreicht ist und
 *  danach mindestens drei weitere Stücke kamen; gemessen wird der Abstand zum Ende NACH jedem Stück (Soll ≤ 5 px). */
async function w20AbsatzLauf(cdp: Cdp): Promise<void> {
  const root = await cdp.evaluate<string>(`return ${PLUGIN}.settings.crewRoot.replace(/\\/+$/, "");`);
  const id = "zz-w20a";
  const ordner = "zz-w20a-ordner";
  const absatz = (n: number): string => `Absatz ${String(n).padStart(2, "0")}: erste Zeile des Absatzes, die Platz braucht.\nzweite Zeile des Absatzes, ebenfalls mit Platz.\ndritte Zeile des Absatzes, damit er größer als die Schwelle wird.\n`;
  const stuecke = Array.from({ length: 24 }, (_, i) => absatz(i + 1));
  const stub = await startLlmStub({ models: ["fake-modell"], takt: 200, nachlaufMs: 800, standard: { stuecke } });
  const team = ["---", "crew-kind: team", "name: ZZ W20a", "version: 1", "description: Smoke", "trigger: manual",
    "limits:", "  max_writes: 1", "write_scope:", `  - "${ordner}/**/*.md"`, "tasks:",
    "  - id: collect", "    kind: collector", "    collector: vault.list", "    params:", `      folder: ${ordner}`,
    "  - id: analyse", "    kind: llm", "    agent: zz-w20a-agent", "    inputs: [collect]", "    instruction: Tue nichts.",
    "    output_schema: triage-v1", "    on_error: skip",
    "  - id: apply", "    kind: actions", "    inputs: [analyse]", "    allowed_actions: [frontmatter.patch]", "    allowed_keys: [priority]",
    "---", "Smoke", ""].join("\n");
  const agent = ["---", "crew-kind: agent", "name: ZZ W20a", "---", "Du bist ein Test.", ""].join("\n");
  const teamPfad = `${root}/teams/${id}.md`;
  const agentPfad = `${root}/agents/zz-w20a-agent.md`;
  const notePfad = `${ordner}/a.md`;
  const saved = await cdp.evaluate<{ endpoints: unknown }>(`return { endpoints: JSON.parse(JSON.stringify(${PLUGIN}.settings.endpoints)) };`);
  let runDir = "";
  try {
    await cdp.evaluate(`
      for (const d of [${JSON.stringify(root)}, ${JSON.stringify(root + "/teams")}, ${JSON.stringify(root + "/agents")}, ${JSON.stringify(ordner)}]) {
        if (!app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d);
      }
      await app.vault.create(${JSON.stringify(teamPfad)}, ${JSON.stringify(team)});
      await app.vault.create(${JSON.stringify(agentPfad)}, ${JSON.stringify(agent)});
      await app.vault.create(${JSON.stringify(notePfad)}, "---\\npriority: mittel\\n---\\nInhalt\\n");
      ${PLUGIN}.settings.endpoints = [{ url: "${stub.urlV1}", model: "fake-modell" }];
      await ${PLUGIN}.refreshTeams?.();
      await ${PLUGIN}.activatePanel();
      return true;`);
    await wartetAuf(cdp, `app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(teamPfad)}))?.frontmatter && app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(agentPfad)}))?.frontmatter`, 8000);
    await cdp.evaluate(`${PANEL}.querySelector('.okit-hub-tab[data-tab="crews"]')?.click(); await new Promise((r) => setTimeout(r, 300)); return true;`);
    // Nur die Kontrolle: absatzgroße Stücke (jedes über der Folge-Schwelle), ohne Störung und Wiederaufnahme — die misst
    // `w20Lauf` am selben Bereich mit tokengroßen Stücken.
    let fehlerFolge = "";
    await starteLaufUndWarteAufBereich(cdp, id);
    const folge = await messeFolge(cdp, {
      ausdruck: `${PANEL}.querySelector(".okit-stream-body")`,
      laeuft: () => cdp.evaluate<boolean>(`return ${PLUGIN}.runActive === true;`),
      stoerung: false,
    }).catch((e: unknown) => { fehlerFolge = e instanceof Error ? e.message : String(e); return null; });
    const fertig = await wartetAuf(cdp, `${PLUGIN}.lastRuns[${JSON.stringify(id)}] && ${PLUGIN}.runActive === false`, 20000);
    if (fertig) {
      const info = await cdp.evaluate<{ runId: string }>(`return ${PLUGIN}.lastRuns[${JSON.stringify(id)}];`);
      runDir = `${root}/runs/${info.runId}`;
    }
    if (folge === null) unmeasured(P_KONTROLLE_ABSATZ, `Folge-Messung nicht zustande gekommen: ${fehlerFolge || "kein Lauf"}`);
    else zeichneFolge(bilanz, { kontrolle: P_KONTROLLE_ABSATZ }, folge);
  } finally {
    await stub.stop();
    await cdp.evaluate(`
      ${PLUGIN}.settings.endpoints = ${JSON.stringify(saved.endpoints)};
      for (const p of [${JSON.stringify(teamPfad)}, ${JSON.stringify(agentPfad)}, ${JSON.stringify(notePfad)}, ${JSON.stringify(ordner)}, ${JSON.stringify(runDir)}]) {
        if (!p) continue;
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      delete ${PLUGIN}.lastRuns[${JSON.stringify(id)}];
      delete window.__vcW20a;
      return true;`).catch(() => undefined);
  }
}

async function abschnittWelle20(cdp: Cdp): Promise<void> {
  try {
    await w20Lauf(cdp);
    await w20AbsatzLauf(cdp);
    record("Welle 20 — Abschnitt lief bis zum Ende", true, "kein Abbruch");
  } catch (e) {
    if (e instanceof AbbruchAusnahme || istAbgebrochen()) throw e;   // ein Abbruch ist kein Befund und wird nicht als „rot“ verbucht
    record("Welle 20 — Abschnitt lief bis zum Ende", false, `abgebrochen: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Welle 15: Schlüsselbund, Schwärzung, Wiederherstellung --------------------

const W15_KEY = "sk-w15-geheim-1234567890abcdef";
const W15_PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----";
const W15_BEARER = "abcdef0123456789abcdef0123456789";

interface W15Antwort { status: number; content?: string; raw?: string }
interface W15Server { stub: LlmStub; port: number; readonly bodies: string[]; readonly auth: Array<string | undefined> }

/** Fake-Endpunkt (zentraler Stub, CORS an — der XHR-Stream-Weg läuft im Renderer): hält jeden gesendeten Chat-Body und
 *  den Authorization-Kopf fest und antwortet, was `antwort` aus dem Body macht. Eine Antwort mit Status ≠ 200 ist ein
 *  echter 4xx mit dem Rohkörper (`roh`), sonst ein Strom mit einem Stück (`teile: 1`). */
async function w15Server(antwort: (body: string) => W15Antwort): Promise<W15Server> {
  const stub = await startLlmStub({
    models: ["fake-modell"],
    antwort: (anfrage) => {
      const a = antwort(anfrage.body);
      return a.status !== 200
        ? { roh: { status: a.status, body: a.raw ?? "{}", contentType: "application/json" } }
        : { text: a.content ?? "", teile: 1 };
    },
  });
  const chat = () => stub.anfragen().filter((x) => x.route === "chat");
  return {
    stub,
    port: stub.port,
    get bodies(): string[] { return chat().map((x) => x.body); },
    get auth(): Array<string | undefined> { return chat().map((x) => (typeof x.header["authorization"] === "string" ? x.header["authorization"] : undefined)); },
  };
}

/** Platzhalter der Schwärzung in der Reihenfolge ihres ersten Auftretens im gesendeten Body. */
function w15Platzhalter(body: string): { pem: string | undefined; token: string | undefined } {
  const alle = [...new Set(body.match(/\[redacted-[a-z0-9-]+-\d+\]/g) ?? [])];
  return { pem: alle.find((p) => p.includes("private-key")), token: alle.find((p) => p.includes("token")) };
}

/** Punkt 1: Klartext-Schlüssel wandert beim ersten Auflösen in den Schlüsselbund, der Lauf bekommt ihn von dort. */
async function w15Schluesselbund(cdp: Cdp, dataPfad: string): Promise<void> {
  const vorher = await cdp.evaluate<unknown>(`return JSON.parse(JSON.stringify(${PLUGIN}.settings.endpoints));`);
  let secretId = "";
  try {
    await cdp.evaluate(`
      ${PLUGIN}.settings.endpoints = [{ url: "http://127.0.0.1:59998/v1", apiKey: ${JSON.stringify(W15_KEY)}, model: "fake-modell" }];
      await ${PLUGIN}.saveSettings();
      return true;`);
    const klartextDa = readFileSync(dataPfad, "utf8").includes(W15_KEY);
    if (!klartextDa) { unmeasured("Welle 15 — Schlüsselbund: nach dem Auflösen steht kein Schlüssel mehr in data.json", "Vorbedingung (Klartext in data.json) nicht herzustellen (gilt auch für die zwei Folgepunkte)"); return; }
    const eps = await cdp.evaluate<Array<{ apiKey?: string }>>(`
      const r = await ${PLUGIN}.effectiveEndpoints();
      await new Promise((ok) => setTimeout(ok, 800));
      return r;`);
    const disk = readFileSync(dataPfad, "utf8");
    const gespeichert = JSON.parse(disk) as { endpoints?: Array<{ apiKey?: string; secretId?: string }> };
    secretId = gespeichert.endpoints?.[0]?.secretId ?? "";
    record("Welle 15 — Schlüsselbund: nach dem Auflösen steht kein Schlüssel mehr in data.json",
      !disk.includes(W15_KEY) && gespeichert.endpoints?.[0]?.apiKey === undefined && secretId !== "",
      `Klartext in data.json: ${disk.includes(W15_KEY) ? "JA" : "nein"} · apiKey-Feld: ${gespeichert.endpoints?.[0]?.apiKey === undefined ? "weg" : "da"} · secretId: ${secretId || "FEHLT"}`);
    const imBund = secretId === "" ? null : await cdp.evaluate<string | null>(`return app.secretStorage.getSecret(${JSON.stringify(secretId)});`);
    record("Welle 15 — Schlüsselbund: der Schlüssel liegt im Schlüsselbund", imBund === W15_KEY, imBund === W15_KEY ? "getSecret liefert den Wert" : `getSecret: ${String(imBund)}`);
    record("Welle 15 — Schlüsselbund: der Lauf bekommt den Schlüssel von dort (nur im Speicher)", eps[0]?.apiKey === W15_KEY,
      eps[0]?.apiKey === W15_KEY ? "effectiveEndpoints trägt apiKey" : `apiKey: ${String(eps[0]?.apiKey)}`);
  } finally {
    await cdp.evaluate(`
      ${secretId ? `app.secretStorage.setSecret(${JSON.stringify(secretId)}, "");` : ""}
      ${PLUGIN}.settings.endpoints = ${JSON.stringify(vorher)};
      await ${PLUGIN}.saveSettings();
      return true;`).catch(() => undefined);
  }
}

/** Punkte 2–4: drei echte Läufe gegen einen Fake-Endpunkt.
 *  (a) JSON-Schema: PEM und Bearer-Token in der Quellnotiz gehen als Platzhalter über den Draht, kommen als
 *      Originale in die Notiz (PEM JSON-maskiert und wieder gültig).
 *  (b) Markdown-Schema (briefing-v1): dasselbe, aber das PEM wörtlich mit Zeilenumbrüchen.
 *  (c) 401 mit dem Schlüssel im Body: weder run.md noch state.json tragen ihn (Schwärzung kennt den Schlüssel aus dem
 *      Schlüsselbund), der Server sah ihn im Authorization-Kopf. */
async function w15Laeufe(cdp: Cdp): Promise<void> {
  const root = await cdp.evaluate<string>(`return ${PLUGIN}.settings.crewRoot.replace(/\\/+$/, "");`);
  const ordner = "zz-w15-ordner";
  const agentPfad = `${root}/agents/zz-w15-agent.md`;
  const vorher = await cdp.evaluate<unknown>(`return JSON.parse(JSON.stringify(${PLUGIN}.settings.endpoints));`);
  const aufraeumen: string[] = [agentPfad];
  const lauf = async (id: string, srv: W15Server, teamZeilen: string[]): Promise<{ runDir: string; info: { runId: string; status: string } | null }> => {
    const teamPfad = `${root}/teams/${id}.md`;
    aufraeumen.push(teamPfad);
    await cdp.evaluate(`
      for (const d of [${JSON.stringify(root)}, ${JSON.stringify(root + "/teams")}, ${JSON.stringify(root + "/agents")}, ${JSON.stringify(ordner)}]) {
        if (!app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d);
      }
      ${PLUGIN}.settings.endpoints = [{ url: "http://127.0.0.1:${srv.port}/v1", model: "fake-modell" }];
      await app.vault.create(${JSON.stringify(teamPfad)}, ${JSON.stringify(teamZeilen.join("\n"))});
      return true;`);
    // Team und Persona stehen erst im metadataCache, wenn der Orchestrator sie lesen kann (Baseline: Welle 8 lief ohne dieses Warten rot).
    await wartetAuf(cdp, `app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(teamPfad)}))?.frontmatter && app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(agentPfad)}))?.frontmatter`, 8000);
    await cdp.evaluate(`await ${PLUGIN}.refreshTeams?.(); delete ${PLUGIN}.lastRuns[${JSON.stringify(id)}]; ${PLUGIN}.runCrew(${JSON.stringify(id)}); return true;`);
    const fertig = await wartetAuf(cdp, `${PLUGIN}.lastRuns[${JSON.stringify(id)}]`, 20000);
    if (!fertig) return { runDir: "", info: null };
    const info = await cdp.evaluate<{ runId: string; status: string }>(`return ${PLUGIN}.lastRuns[${JSON.stringify(id)}];`);
    aufraeumen.push(`${root}/runs/${info.runId}`);
    return { runDir: `${root}/runs/${info.runId}`, info };
  };
  const kopf = (id: string, name: string, schema: string[], extra: string[]): string[] => ["---", "crew-kind: team", `name: ${name}`, "version: 1", "description: Smoke", "trigger: manual",
    "limits:", "  max_writes: 3", "write_scope:", `  - "${ordner}/**/*.md"`, "tasks:",
    "  - id: collect", "    kind: collector", "    collector: tasknotes.query", "    params:", `      folder: ${ordner}`, "      include_content: true",
    "  - id: analyse", "    kind: llm", "    agent: zz-w15-agent", "    inputs: [collect]", "    instruction: Schreibe die Werte der Notiz heraus.",
    ...schema, "    on_error: abort", "  - id: apply", "    kind: actions", "    inputs: [analyse]", ...extra, "---", id, ""];
  try {
    await cdp.evaluate(`
      for (const d of [${JSON.stringify(root)}, ${JSON.stringify(root + "/teams")}, ${JSON.stringify(root + "/agents")}, ${JSON.stringify(ordner)}]) {
        if (!app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d);
      }
      await app.vault.adapter.write(${JSON.stringify(agentPfad)}, ${JSON.stringify(["---", "crew-kind: agent", "name: ZZ W15", "---", "Du bist ein Test.", ""].join("\n"))});
      await app.vault.adapter.write(${JSON.stringify(`${ordner}/a.md`)}, ${JSON.stringify(`Notiz mit Geheimnissen.\n\n${W15_PEM}\n\nAuthorization: Bearer ${W15_BEARER}\n`)});
      return true;`);
    aufraeumen.push(`${ordner}/a.md`);

    // (a) JSON-Schema
    const a = await w15Server((body) => {
      const ph = w15Platzhalter(body);
      return { status: 200, content: JSON.stringify({ items: [{ path: `${ordner}/a.md`, set: { pem: ph.pem ?? "FEHLT", token: ph.token ?? "FEHLT" } }] }) };
    });
    try {
      const l = await lauf("zz-w15-json", a, kopf("zz-w15-json", "ZZ W15 json", ["    output:", "      family: frontmatter.set", "      allowed_keys: [pem, token]"],
        ["    allowed_actions: [frontmatter.patch]", "    allowed_keys: [pem, token]"]));
      const body = a.bodies[0] ?? "";
      record("Welle 15 — Schwärzung: PEM und Bearer-Token gehen nicht im Klartext an den Server",
        a.bodies.length >= 1 && !body.includes("BEGIN PRIVATE KEY") && !body.includes("MIIEvQ") && !body.includes(W15_BEARER),
        a.bodies.length === 0 ? "Server sah keine Anfrage (Lauf: " + String(l.info?.status) + ")" : `Platzhalter am Draht: ${JSON.stringify(w15Platzhalter(body))}`);
      const note = await cdp.evaluate<string>(`return await app.vault.adapter.read(${JSON.stringify(`${ordner}/a.md`)});`);
      record("Welle 15 — Wiederherstellung (JSON-Schema): die Notiz trägt PEM und Token im Original, kein Platzhalter",
        l.info?.status === "ok" && note.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC") && note.includes(W15_BEARER) && !note.includes("[redacted-"),
        `Status ${String(l.info?.status)} · PEM ${note.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC") ? "da" : "FEHLT"} · Token ${note.includes(W15_BEARER) ? "da" : "FEHLT"} · Platzhalter ${note.includes("[redacted-") ? "STEHT NOCH DA" : "weg"}`);
    } finally { await a.stub.stop(); }

    // (b) Markdown-Schema — mit frischer Quellnotiz: der Lauf (a) hat PEM und Token in a.md geschrieben, und ein zweiter
    // Lauf über dieselbe Notiz sähe dort zwei verschiedene PEM-Platzhalter (der erste wäre der schon JSON-maskierte Wert).
    await cdp.evaluate(`
      const alt = app.vault.getAbstractFileByPath(${JSON.stringify(`${ordner}/a.md`)});
      if (alt) await app.vault.delete(alt, true);
      await app.vault.adapter.write(${JSON.stringify(`${ordner}/b.md`)}, ${JSON.stringify(`Notiz mit Geheimnissen.\n\n${W15_PEM}\n`)});
      return true;`);
    aufraeumen.push(`${ordner}/b.md`);
    const b = await w15Server((body) => {
      const ph = w15Platzhalter(body);
      return { status: 200, content: `Gefunden:\n\n${ph.pem ?? "FEHLT"}\n` };
    });
    try {
      const l = await lauf("zz-w15-text", b, kopf("zz-w15-text", "ZZ W15 text", ["    output_schema: briefing-v1"],
        ["    allowed_actions: [section.replace]", `    target: "${ordner}/ziel.md"`, "    create_if_missing: true"]));
      aufraeumen.push(`${ordner}/ziel.md`);
      const ziel = await cdp.evaluate<string>(`const f = app.vault.getAbstractFileByPath(${JSON.stringify(`${ordner}/ziel.md`)}); return f ? await app.vault.read(f) : "";`);
      // Das Modell sieht Quellnotizen als JSON-Text im Prompt: ein PEM steht dort mit `\\n` statt echten Zeilenumbrüchen, und dieser
      // Wortlaut ist das „Original", das zurückkommt. Mit dem Modus json käme es ein zweites Mal maskiert (`\\\\n`) in die Notiz.
      const einfach = ziel.includes("-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
      const doppelt = ziel.includes("-----BEGIN PRIVATE KEY-----\\\\n");
      record("Welle 15 — Wiederherstellung (Markdown-Schema): das PEM kommt im Wortlaut des Prompts zurück, nicht ein zweites Mal maskiert",
        l.info?.status === "ok" && einfach && !doppelt && !ziel.includes("[redacted-"),
        `Status ${String(l.info?.status)} · ${doppelt ? "DOPPELT maskiert (\\\\n)" : einfach ? "Wortlaut des Prompts (\\n)" : "PEM fehlt"} · Platzhalter ${ziel.includes("[redacted-") ? "STEHT NOCH DA" : "weg"}`);
    } finally { await b.stub.stop(); }

    // (c) 401 mit dem Schlüssel im Body
    const c = await w15Server(() => ({ status: 401, raw: JSON.stringify({ error: { message: `Incorrect API key provided: ${W15_KEY}` } }) }));
    let secretId = "";
    try {
      await cdp.evaluate(`
        ${PLUGIN}.settings.endpoints = [{ url: "http://127.0.0.1:${c.port}/v1", apiKey: ${JSON.stringify(W15_KEY)}, model: "fake-modell" }];
        await ${PLUGIN}.saveSettings();
        return true;`);
      const teamPfad = `${root}/teams/zz-w15-401.md`;
      aufraeumen.push(teamPfad);
      await cdp.evaluate(`
        await app.vault.create(${JSON.stringify(teamPfad)}, ${JSON.stringify(kopf("zz-w15-401", "ZZ W15 401", ["    output:", "      family: frontmatter.set", "      allowed_keys: [pem]"],
          ["    allowed_actions: [frontmatter.patch]", "    allowed_keys: [pem]"]).join("\n"))});
        return true;`);
      await wartetAuf(cdp, `app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(teamPfad)}))?.frontmatter`, 8000);
      await cdp.evaluate(`await ${PLUGIN}.refreshTeams?.(); delete ${PLUGIN}.lastRuns["zz-w15-401"]; ${PLUGIN}.runCrew("zz-w15-401"); return true;`);
      const fertig = await wartetAuf(cdp, `${PLUGIN}.lastRuns["zz-w15-401"]`, 20000);
      secretId = await cdp.evaluate<string>(`return ${PLUGIN}.settings.endpoints[0]?.secretId ?? "";`);
      if (!fertig) { record("Welle 15 — 401-Body: der Schlüssel wird in run.md und state.json maskiert", false, "Lauf endete nicht innerhalb von 20 s"); }
      else {
        const info = await cdp.evaluate<{ runId: string; status: string }>(`return ${PLUGIN}.lastRuns["zz-w15-401"];`);
        const dir = `${root}/runs/${info.runId}`;
        aufraeumen.push(dir);
        const dateien = await cdp.evaluate<Record<string, string>>(`
          const out = {};
          for (const n of ["run.md", "state.json"]) { try { out[n] = await app.vault.adapter.read(${JSON.stringify(dir)} + "/" + n); } catch { out[n] = ""; } }
          return out;`);
        const lecks = Object.entries(dateien).filter(([, t]) => t.includes(W15_KEY)).map(([n]) => n);
        const leer = Object.entries(dateien).filter(([, t]) => t === "").map(([n]) => n);
        record("Welle 15 — 401-Body: der Schlüssel wird in run.md und state.json maskiert",
          lecks.length === 0 && leer.length === 0 && info.status !== "ok" && c.bodies.length >= 1,
          lecks.length > 0 ? `SCHLÜSSEL IN: ${lecks.join(", ")}` : leer.length > 0 ? `nicht gelesen: ${leer.join(", ")}` : `Status ${info.status} · run.md/state.json ohne Schlüssel · Server sah ${c.bodies.length} Anfrage(n)`);
        record("Welle 15 — der Schlüssel kommt aus dem Schlüsselbund an den Draht (Authorization-Kopf)",
          c.auth.includes(`Bearer ${W15_KEY}`), `Kopf am Server: ${c.auth[0] === undefined ? "keiner" : c.auth[0].replace(W15_KEY, "<Schlüssel>")}`);
      }
    } finally {
      await c.stub.stop();
      if (secretId) await cdp.evaluate(`app.secretStorage.setSecret(${JSON.stringify(secretId)}, ""); return true;`).catch(() => undefined);
    }
  } finally {
    await cdp.evaluate(`
      for (const p of ${JSON.stringify(aufraeumen)}) {
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      for (const id of ["zz-w15-json", "zz-w15-text", "zz-w15-401"]) delete ${PLUGIN}.lastRuns[id];
      ${PLUGIN}.settings.endpoints = ${JSON.stringify(vorher)};
      await ${PLUGIN}.saveSettings();
      return true;`).catch(() => undefined);
  }
}

async function abschnittWelle15(cdp: Cdp, dataPfad: string): Promise<void> {
  try {
    await w15Schluesselbund(cdp, dataPfad);
    await w15Laeufe(cdp);
    record("Welle 15 — Abschnitt lief bis zum Ende", true, "kein Abbruch");
  } catch (e) {
    if (e instanceof AbbruchAusnahme || istAbgebrochen()) throw e;   // ein Abbruch ist kein Befund und wird nicht als „rot“ verbucht
    record("Welle 15 — Abschnitt lief bis zum Ende", false, `abgebrochen: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  if (!Number.isInteger(PORT) || PORT <= 0) {
    throw new Vorbedingung("--port <port> ist Pflicht (Zweitinstanz, siehe Kopf dieser Datei); kein Standardport.");
  }
  const cdp = await attachTo("workspace", PORT, VAULT);
  if (!cdp) {
    console.error(
      `Kein Obsidian-Fenster${VAULT ? ` fuer Vault „${VAULT}"` : ""} am Port ${PORT}.\n`
      + "Zweitinstanz starten (Rezept im Kopf dieser Datei), nicht die regulaere Instanz neu starten.",
    );
    process.exitCode = 1;
    return;
  }

  let aktiv = await cdp.evaluate<boolean>(
    `return Boolean(app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]);`,
  );
  // Ein frisch gebauter Staging-Vault startet im Restricted Mode (und ein frisches Profil fragt
  // „Dem Ersteller vertrauen"): `bereiteInstanzVor` der zentralen Brücke bestätigt den Dialog und
  // schaltet frei — aber NUR im eigenen Staging-Vault (heißt wie das Repo, `nurVault`); in einem
  // fremden Vault wäre das ein Eingriff in den Wirt, dort bleibt es beim Abbruch mit Ansage.
  if (!aktiv) {
    const r = await bereiteInstanzVor(cdp, { pluginIds: [PLUGIN_ID], nurVault: PLUGIN_ID });
    console.log(`Instanz vorbereitet: ${r.hinweis}`);
    aktiv = r.plugins[PLUGIN_ID] === "geladen";
  }
  if (!aktiv) {
    console.error(
      `Plugin „${PLUGIN_ID}" ist im geoeffneten Vault nicht aktiv.\n`
      + `Frischer Vault im Restricted Mode? Der Treiber schaltet nur im Staging-Vault „${PLUGIN_ID}" selbst frei.`,
    );
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
    if (e instanceof AbbruchAusnahme) throw e;
    throw new Vorbedingung(e instanceof Error ? e.message : String(e));
  }

  // Läuft dieser Lauf gegen den eigenen Stand? Der Store-Build trägt dieselbe Versionsnummer; `ladePluginNeu` prüft mit
  // `repoMainJs` vor dem Reload, dass `main.js` im Vault der frisch gebaute Repo-Stand ist (CORE-TEST-08 a), und stellt
  // danach die Version auf der Platte neben die im Speicher (Obsidian hält den zuvor geladenen Stand).
  try {
    const neu = await ladePluginNeu(cdp, PLUGIN_ID, { repoMainJs: join(cwd(), "main.js") });
    console.log(neu.hinweis);
    if (!neu.geladen || !neu.aktuell) throw new Error(neu.hinweis);
  } catch (e) {
    cdp.close();
    if (e instanceof AbbruchAusnahme) throw e;
    throw new Vorbedingung(e instanceof Error ? e.message : String(e));
  }

  const basis = await cdp.evaluate<string>(`return app.vault.adapter.basePath;`);
  const dataPfad = `${basis}/${await cdp.evaluate<string>("return app.vault.configDir;")}/plugins/${PLUGIN_ID}/data.json`;
  const rettung = `${dataPfad}.smoke-rettung`;

  // Eine Rettungskopie aus einem VORLAUF (SIGKILL oder Absturz vor diesem Handler existierte)
  // waere sonst still gefaehrlich: weicht sie vom aktuellen data.json ab, steht dort noch die
  // Migrations-Fixtur eines fruehen Laufs — und DIESER Lauf wuerde sie gleich als "vorwert"
  // (Original) capturen und am Ende treu auf sich selbst zurueckschreiben, statt die echten
  // Einstellungen wiederherzustellen. Deshalb: vor dem Lesen von `vorwert` erst pruefen und
  // im Zweifel aus der Rettungskopie restaurieren.
  const rettungVorher = existsSync(rettung) ? readFileSync(rettung) : null;
  const aktuellVorRestore = existsSync(dataPfad) ? readFileSync(dataPfad) : null;
  const rettungWeichtAb = rettungVorher !== null
    && (aktuellVorRestore === null || !rettungVorher.equals(aktuellVorRestore));
  record(
    "Keine liegen gebliebene Rettungskopie aus einem abgebrochenen Vorlauf",
    !rettungWeichtAb,
    rettungWeichtAb
      ? `${rettung} weicht vom aktuellen data.json ab — data.json daraus wiederhergestellt`
      : "kein abweichender Rest gefunden",
  );
  if (rettungWeichtAb && rettungVorher) writeFileSync(dataPfad, rettungVorher);

  // Der Vorwert wird VOR dem try gelesen und liegt zusaetzlich als Datei neben dem
  // Original: das `finally` laeuft bei Ctrl-C oder einem Absturz des Node-Prozesses
  // nicht mehr — und was dann im produktiven Vault stuende, waere eine Testfixtur.
  const vorwert = existsSync(dataPfad) ? readFileSync(dataPfad) : null;
  if (vorwert) copyFileSync(dataPfad, rettung);

  // Alles, was dieser Lauf am Wirt verändert, räumt EIN Schritt zurück: der Normalweg im `finally` (`zustand.schliesse()`),
  // Ctrl-C/SIGTERM über das Abbruch-Modul der Brücke (Hauptzweig gesperrt, dieser Schritt darf noch senden, danach Bilanz,
  // Exit 130). Die Rettungskopie oben bleibt die Absicherung GEGEN SIGKILL/Absturz (von Hand einspielbar).
  // Vier Sorten Zustand: data.json (Node-Seite, Migrations-Fixtur), Plugin-Einstellungen im Speicher (der Reload aus der
  // zurückgeschriebenen data.json), neue Dateien und Ordner im Vault (alles, was nach dem Start dazukam: Teams, Agents,
  // Notizen, Läufe) und der Fake-Manager im Slot. Der Hauptzweig kann nach dem Signal nicht mehr schreiben (Sperre), der alte
  // zweite Vergleich „NACH dem Reload“ entfällt. Im Abbruch wird nicht gewartet (Frist je Schritt 1 s).
  const dateienVorher = await cdp.evaluate<string[]>(`return app.vault.getAllLoadedFiles().map((f) => f.path);`);
  const zustandZurueck = async (): Promise<void> => {
    const imAbbruch = istAbgebrochen();
    await entferneFakeManager(cdp).catch(() => undefined);
    // Ein Crew-Lauf, der beim Signal im Plugin läuft, schreibt nach dem Ende des Treibers weiter (run.md, `lastRuns` und, über
    // `saveSettings` der alten Instanz, die Stub-Endpunkte in data.json) und überschriebe die Rückstellung. Gemessen 2026-10-14:
    // kill -INT im Strom-Abschnitt, danach stand `lastRuns.zz-w20` und die Stub-URL in data.json. Deshalb zuerst abbrechen und
    // höchstens 400 ms auf das Ende des Laufs warten (Frist des Schritts 1 s).
    await cdp.evaluate(`
      const p = ${PLUGIN};
      if (p && p.runActive) {
        p.abortCurrentRun();
        for (let i = 0; i < 16 && p.runActive; i++) await new Promise((r) => setTimeout(r, 25));
      }
      return true;`).catch(() => undefined);
    await cdp.evaluate(`
      const vorher = new Set(${JSON.stringify(dateienVorher)});
      const neu = app.vault.getAllLoadedFiles().filter((f) => f.path !== "/" && !vorher.has(f.path)).map((f) => f.path)
        .sort((a, b) => b.length - a.length);
      for (const p of neu) {
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      app.setting.close();
      return neu.length;`).catch(() => undefined);
    if (vorwert) {
      writeFileSync(dataPfad, vorwert);
      await pluginNeuLaden(cdp, imAbbruch ? 0 : 900).catch(() => undefined);
      const gleich = existsSync(dataPfad) && readFileSync(dataPfad).equals(vorwert);
      console.log(gleich ? "\ndata.json zurueckgeschrieben: byte-gleich" : "\ndata.json ABWEICHUNG — Rettungskopie bleibt liegen: " + rettung);
      if (gleich && !KEEP && existsSync(rettung)) rmSync(rettung);
    }
  };
  const zustand = beimAbbruch(zustandZurueck, "Wirt-Zustand zurücksetzen (data.json, Plugin neu laden, neue Vault-Dateien, Fake-Manager)");

  try {
    if (vorwert) {
      await abschnittMigration(cdp, dataPfad);
    } else {
      alleUebersprungen([
        "Alte Endpunkt-Liste wird zu genau einem Eintrag",
        "Das alte globale Modell landet in der Zeile und geht nicht verloren",
        "Das globale Modellfeld existiert nicht mehr",
        "Die übrigen Einstellungen überstehen die Migration",
        "Ein kaputtes data.json-Feld reisst den Plugin-Start nicht mit",
      ], "keine data.json vorhanden");
    }

    // Ab hier gegen den ECHTEN Stand messen, nicht gegen die Migrations-Fixtur.
    if (vorwert) {
      writeFileSync(dataPfad, vorwert);
      await pluginNeuLaden(cdp);
    }
    await abschnittEinstellungen(cdp);
    await abschnittDeklarativ(cdp);
    await abschnittDrittanbieter(cdp);
    await abschnittPanel(cdp);
    await abschnittWelle8(cdp);
    await abschnittWelle14(cdp);
    await abschnittWelle15(cdp, dataPfad);
    await abschnittWelle20(cdp);
  } finally {
    // Zurueckschreiben und das Ergebnis MESSEN statt darauf vertrauen; nach einem Abbruch räumt das Modul auf.
    await zustand.schliesse();
    if (istAbgebrochen()) return;

    // Die Abschlusszeile trägt alle vier Zustände: ein übersprungener oder nie gemessener Punkt
    // gehört IN sie, sonst wird aus „13/13 grün" beim Zitieren ein bestandener Smoke, obwohl ein
    // Teil nie gemessen wurde. `abschluss()` setzt Exit 1 bei Rot ODER nichts gemessen.
    const ende = bilanz.abschluss();
    for (const p of bilanz.eintraege()) {
      if (p.zustand === "rot" || p.zustand === "nichts-gemessen") console.log(`  ${p.name} — ${p.detail}`);
    }
    void ende;
    cdp.close();
  }
}

runDriver(async () => {
  try {
    await main();
  } catch (e) {
    if (e instanceof Vorbedingung) {
      console.error(`\nAbbruch — Umgebungsbedingung nicht erfüllt:\n${e.message}`);
      process.exitCode = 2;   // eigener Code: nicht gemessen ist nicht dasselbe wie durchgefallen
    } else {
      throw e;
    }
  }
});
