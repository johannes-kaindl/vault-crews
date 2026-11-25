// vendored from code-kit@0.91.1, src/ts/pure/settings_schema.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** Validierender Settings-Merge (**geschlossene Welt**) — das Ergebnis hat GENAU die
 *  Schlüssel von `defaults`, und jedes Feld ist entweder ein geprüfter Wert aus `raw` oder
 *  der Default. `data.json` liegt im Vault des Nutzers: handeditiert, von einem
 *  Sync-Konflikt zerlegt oder aus einer künftigen Version zurückgerollt — ein Spread
 *  reichte jeden Müllwert unbesehen an Renderpfade weiter, die auf die Form vertrauen.
 *
 *  **Das ist Schicht 2 und ein ERGÄNZUNG zu `pure/settings.ts::mergeSettings`, kein Ersatz.**
 *  Schicht 1 (`mergeSettings`) ist offene Welt: unbekannte raw-Felder bleiben erhalten
 *  (Forward-Compat; vault-crews' `lastRuns`, yijing-oracle `migrate.ts`, json_viewer hängen
 *  daran). Schicht 2 (hier) wirft sie weg. Beide Verträge sind gewollt, deshalb tragen sie
 *  verschiedene NAMEN statt eines Flags: `mergeSettings` = behalten, `validateSettings` =
 *  verwerfen. Wer beides will, ruft beides — aber das ist ein Widerspruch in sich.
 *  *(Die zwei Schichten hießen bis 2026-08-19 in mehreren Repos beide `mergeSettings`; das
 *  hat in einer drift-audit-Runde eine Test-„Kollision" vorgetäuscht, die keine war.)*
 *
 *  Kanonische Quelle: `audio-interface/src/core/settings-types.ts::normalizeSettings`
 *  (2026-08-12) — dessen generische Feldschleife IST der Kern. Zusammengeführt beim Heben
 *  ins Kit (2026-08-19) mit vier unabhängig entstandenen Fassungen desselben
 *  Fünf-Schritt-Algorithmus:
 *  `3d-codeblocks/src/core/settings-types.ts::mergeSettings`,
 *  `local-image-generator/src/core/settings.ts::sanitizeSettings`,
 *  `koda-agent/src/core/settings-types.ts::mergeKodaSettings`,
 *  `apple-health/src/main.ts::loadPluginData` (inline).
 *  Jeder Unterschied der fünf ist hier ein `FieldCheck` geworden, keiner ein Ausschlussgrund.
 *
 *  ⚠️ Beim Übernehmen zu beachten:
 *  - **Die Feldliste kommt aus `defaults`, nie aus `raw`.** Ein Feld, das nicht in
 *    `defaults` steht, existiert im Ergebnis nicht — auch dann nicht, wenn ein
 *    Schema-Eintrag dafür da ist (der wird schlicht nie aufgerufen). Ein Alt-Key in einer
 *    data.json verschwindet damit beim nächsten Speichern; das ist der Preis der
 *    geschlossenen Welt und der Grund, warum `mergeSettings` daneben stehen bleibt.
 *  - **Ein Schema-Eintrag ERSETZT die generische typeof-Prüfung für sein Feld.** Er
 *    bekommt den ROHEN Wert. Sonst käme z. B. koda-agents `"25"` nie bei `clampInt` an,
 *    weil die generische Prüfung den String vorher auf den Default zurückgeworfen hätte.
 *  - **Kein Wert im Ergebnis teilt einen Container mit `defaults` oder mit `raw`**: jedes
 *    Array und jedes Plain-Object wird rekursiv frisch aufgebaut (anders als
 *    `mergeSettings`, das nur eine Ebene tief `slice()`/Spread macht). Genau dieser Fehler
 *    ist in drei Repos unabhängig entdeckt worden — ohne den Klon verunreinigt die erste
 *    Plugin-Instanz im Prozess (Dev-Hot-Reload, Deaktivieren/Aktivieren) die
 *    Modul-Vorlage selbst, und jede spätere Instanz sieht deren Endzustand statt der
 *    Defaults. Der Klon setzt JSON-artige Werte voraus (Zahl/String/Boolean/null/Array/
 *    Plain-Object) — genau das, was `loadData()` liefern kann. Alles andere (Date, Map,
 *    Klasseninstanz) wird NICHT nachgebaut, sondern unangetastet durchgereicht; ein
 *    zyklischer Default würde den Klon in die Rekursion schicken.
 *  - **Idempotent.** Vier der fünf Quell-Repos benutzen ihre Fassung ein zweites Mal als
 *    Schreibpfad des Settings-Tabs (`validateSettings(D, { ...settings, [key]: value })`) —
 *    das ist die einzige Stelle, die Müllwerte aus deklarativen Hosts abfängt.
 *  - Weil die Funktion fehlende Felder selbst aus `defaults` füllt, ist ein vorgeschaltetes
 *    `mergeSettings` überflüssig. Beim Migrieren darf es trotzdem zunächst stehen bleiben
 *    (das Ergebnis ändert sich nicht) und in einem zweiten Commit entfallen. */

import { clampInt } from "./num";

/** Prüft EIN Feld. Bekommt den ROHEN Wert (`unknown`, direkt aus `data.json`) und den
 *  Default des Feldes; liefert den gültigen Wert.
 *
 *  Der `fallback` ist bereits ein frischer Klon des Defaults — ein Prüfer darf ihn behalten,
 *  zurückgeben und sogar verändern, ohne die Modul-Vorlage zu berühren. */
export type FieldCheck<V> = (raw: unknown, fallback: V) => V;

/** Optionale Prüfer je Feld. Ein Feld ohne Eintrag bekommt die generische typeof-Prüfung
 *  gegen seinen Default (siehe {@link validateSettings}). */
export type SettingsSchema<T> = { readonly [K in keyof T]?: FieldCheck<T[K]> };

/** `typeof null === "object"` — die Null-Prüfung ist der eigentliche Punkt hier.
 *  Arrays zählen NICHT als Plain-Object.
 *
 *  Lag byte-nah dupliziert in `local-image-generator/src/core/settings.ts` und
 *  `apple-health/src/main.ts`; als Prädikat für `check()` gedacht (`sectionsCollapsed`,
 *  `collapsed`). Bewusst eine reine Laufzeit-Prüfung ohne Prototyp-Vergleich: sie
 *  beurteilt `JSON.parse`-Ausgabe, und die hat nie einen fremden Prototyp. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Nur ein *echtes* Plain-Object wird vom Klon nachgebaut. Strenger als
 *  {@link isPlainObject}, und zwar mit Absicht: was der Klon nicht erkennt, reicht er
 *  unangetastet durch, statt eine Date/Map in ein leeres `{}` zu verwandeln. */
function isRebuildable(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Baut Arrays und Plain-Objects rekursiv neu auf; alles andere bleibt, wie es ist. */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return (value as readonly unknown[]).map((item) => cloneValue(item));
  if (isRebuildable(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
    return out;
  }
  return value;
}

/** Die generische Prüfung: passt der rohe Wert zur BAUFORM seines Defaults?
 *  - Array-Default → nur ein Array wird genommen (`favorites: null` fällt auf `[]`).
 *  - Objekt-Default → nur ein Plain-Object (`collapsed: "nope"` fällt auf `{}`).
 *  - Zahl-Default → nur eine ENDLICHE Zahl (`NaN`/`Infinity` fallen zurück; ein String
 *    ebenfalls — wer `"25"` retten will, nimmt `clampIntField`).
 *  - `null`/`undefined` als Default trägt keine Typinformation. Dann wird jeder
 *    vorhandene Wert übernommen — ein Feld vom Typ `number | null` gehört deshalb an
 *    einen eigenen Schema-Eintrag, sonst ist es faktisch ungeprüft. */
function acceptsShape(value: unknown, def: unknown): boolean {
  if (value === undefined) return false;
  if (Array.isArray(def)) return Array.isArray(value);
  if (def === null || def === undefined) return true;
  if (typeof def === "object") return isPlainObject(value);
  if (typeof def === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === typeof def;
}

/** Baut aus `defaults` und einem ungeprüften `raw` (das Ergebnis von `loadData()`) einen
 *  gültigen Settings-Stand. Geschlossene Welt: die Schlüsselmenge ist exakt
 *  `Object.keys(defaults)`; unbekannte raw-Felder werden verworfen.
 *
 *  Je Feld: gibt es einen Schema-Eintrag, entscheidet ausschließlich er (er bekommt den
 *  rohen Wert); sonst greift die Bauform-Prüfung gegen den Default. Fehlschlag → Default.
 *  `raw`, das kein Plain-Object ist (`null`, `undefined`, String, Array), liefert eine
 *  reine Default-Kopie.
 *
 *  @example
 *  const s = validateSettings(DEFAULT_SETTINGS, await this.loadData(), {
 *    viewMode: oneOf(["immediate", "on-click"]),
 *    defaultHeight: check((v) => typeof v === "number" && Number.isFinite(v) && v > 0),
 *  }); */
export function validateSettings<T extends object>(defaults: T, raw: unknown, schema?: SettingsSchema<T>): T {
  const defs = defaults as unknown as Record<string, unknown>;
  const source: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  // Der Doppel-Cast ist die Kehrseite der präzisen Schema-Typisierung: `FieldCheck<T[K]>`
  // ist wegen des kontravarianten `fallback`-Parameters nicht direkt `FieldCheck<unknown>`.
  const checks = (schema ?? {}) as unknown as Record<string, FieldCheck<unknown> | undefined>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defs)) {
    const fallback = cloneValue(defs[key]);
    const rawValue = source[key];
    const fieldCheck = checks[key];
    const value = fieldCheck
      ? fieldCheck(rawValue, fallback)
      : acceptsShape(rawValue, defs[key])
        ? rawValue
        : fallback;
    // `fallback` ist schon frisch; alles andere kommt aus `raw` (oder aus einem Prüfer) und
    // wird hier zum eigenen Container — sonst teilte ein `{ ...DEFAULTS }` als `raw` seine
    // Arrays weiterhin mit der Modul-Vorlage.
    out[key] = value === fallback ? value : cloneValue(value);
  }
  return out as T;
}

/** Nur einer aus einer festen Liste, sonst Default — die Enum-Prüfung.
 *  (3d `viewMode`/`panelPlacement`, LIG `createMode`/`historyView`/`engine`,
 *  audio `exportProfile`, apple-health `exportFormat`.)
 *
 *  @example oneOf(["md", "csv"]) */
export function oneOf<V extends string | number | boolean>(allowed: readonly V[]): FieldCheck<V> {
  return (raw, fallback) => ((allowed as readonly unknown[]).includes(raw) ? (raw as V) : fallback);
}

/** Beliebiges Prädikat: hält es, wird der ROHE Wert übernommen, sonst der Default.
 *  Der Aufrufer bürgt dafür, dass das Prädikat wirklich `V` beweist — ein `(v): v is V`
 *  ist deshalb die bessere Wahl, wo es zu haben ist.
 *
 *  @example check((v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 50)
 *  @example check(isPlainObject) */
export function check<V>(isValid: (v: unknown) => boolean): FieldCheck<V> {
  return (raw, fallback) => (isValid(raw) ? (raw as V) : fallback);
}

/** Ganzzahl in `[min, max]` klemmen, **String-tolerant** — `"25"` wird zu `25`, `"viel"`
 *  zum Default. Delegiert an `pure/num.ts::clampInt` (Floats werden getrunct, nicht gerundet).
 *
 *  Klemmen statt verwerfen heißt: wer 0 oder 999 einträgt, meint „so wenig/viel wie
 *  möglich". Wer das NICHT will, nimmt `check(...)` und bekommt den Default zurück.
 *
 *  @example clampIntField(1, 50) */
export function clampIntField(min: number, max: number): FieldCheck<number> {
  return (raw, fallback) =>
    typeof raw === "number" || typeof raw === "string" ? clampInt(raw, min, max, fallback) : fallback;
}

/** Kommazahl in `[min, max]` klemmen — **nur echte, endliche Zahlen**, kein `parseFloat`.
 *  `"1.5"` fällt auf den Default (audio-interface pinnt das per Test: ein String im
 *  Zahlenfeld ist ein kaputtes data.json, kein Wunsch).
 *
 *  Der Unterschied zu {@link clampIntField} ist genau diese String-Toleranz — deshalb zwei
 *  Kombinatoren statt eines mit Flag.
 *
 *  @example clampFloatField(0.5, 2) */
export function clampFloatField(min: number, max: number): FieldCheck<number> {
  return (raw, fallback) =>
    typeof raw === "number" && Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
}

/** String, der nicht leer sein darf — „leer" heißt „nicht gesetzt", also Default.
 *
 *  `trim` entscheidet, wie streng „leer" gemeint ist und WAS gespeichert wird:
 *  - `false` (Default) — nur `""` ist leer, der Wert wird unverändert übernommen.
 *  - `"check"` — Ränder zählen beim Leer-Test mit (`"   "` ist leer), gespeichert wird der
 *    ROHE Wert. Fassung aus `audio-interface` (`exportFilePattern`).
 *  - `true` — Ränder zählen beim Leer-Test mit, gespeichert wird der GETRIMMTE Wert.
 *    Fassung aus `local-image-generator` (`assetBaseUrl`).
 *
 *  Die zwei Trim-Fassungen sind ein echter Unterschied der Quellen und bleiben deshalb
 *  beide wählbar. **Ein leerer String ist nicht überall ungültig** — 3d `lockedNodePrefixes`
 *  („nichts sperren"), audio `exportFolder` („neben der Notiz"), LIG `outputFolder`
 *  (Obsidians Attachment-Logik) meinen mit `""` etwas. Diese Felder bekommen KEINEN
 *  Schema-Eintrag; die generische typeof-Prüfung reicht.
 *
 *  @example nonEmptyString({ trim: true }) */
export function nonEmptyString(opts?: { trim?: boolean | "check" }): FieldCheck<string> {
  const trim = opts?.trim ?? false;
  return (raw, fallback) => {
    if (typeof raw !== "string") return fallback;
    if (trim === false) return raw === "" ? fallback : raw;
    const trimmed = raw.trim();
    if (trimmed === "") return fallback;
    return trim === true ? trimmed : raw;
  };
}

/** Array, dessen Elemente einzeln geprüft werden: Nicht-Array → Default, sonst bleiben nur
 *  die Elemente übrig, die `isItem` bestehen. Ein kaputter Eintrag kostet nicht die ganze
 *  Liste. (LIG `presets`.)
 *
 *  @example arrayOf((p) => isPlainObject(p) && typeof p["id"] === "string") */
export function arrayOf<V>(isItem: (v: unknown) => boolean): FieldCheck<V[]> {
  return (raw, fallback) => (Array.isArray(raw) ? ((raw as readonly unknown[]).filter(isItem) as V[]) : fallback);
}

/** Array, das als Ganzes durch eine Migration läuft: Nicht-Array → Default, sonst
 *  `migrate(raw)`. Für die Fälle, in denen Filtern nicht reicht, weil Alt-Einträge
 *  umgeschrieben oder aufgefüllt werden (koda `endpoints` → `migrateEndpointList`,
 *  apple-health `favorites` → `migrateFavorites`, LIG `history` → Feld-Backfill).
 *
 *  Die Migration bekommt den rohen Inhalt und ist selbst dafür zuständig, Müll zu
 *  verwerfen — sie ist die einzige Stelle, die die Alt-Form kennt.
 *
 *  @example arrayThen((items) => migrateFavorites(items as string[])) */
export function arrayThen<V>(migrate: (items: unknown[]) => V[]): FieldCheck<V[]> {
  return (raw, fallback) => (Array.isArray(raw) ? migrate(raw as unknown[]) : fallback);
}
