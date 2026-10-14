# Smoke-Checkliste

Zwei Teile: was der Treiber `npm run smoke:gui` **misst**, und was Hand und Auge
vorbehalten bleibt. Die Aufteilung ist keine Bequemlichkeit — automatisiert wird, was
mechanisch entscheidbar ist; „sieht gut aus" bleibt beim Menschen.

## Automatisiert — `npm run smoke:gui -- --vault <name>`

⚠️ **Der Smoke läuft in einer Zweitinstanz, nie in der regulären Instanz.** Obsidian ist geteilte
Infrastruktur: ein `quit` oder `activate` trifft die Instanz, an der möglicherweise eine andere Session
arbeitet. Das Startrezept (eigenes `--user-data-dir`, eigener Port, aktuelle `.asar`,
Vertrauensdialog) steht im Kopf von `tools/obsidian-cdp/cdp.ts`, in der `AGENTS.md` des Dachs
(§ Staging-Vaults) und in der README der Brücke (§ Zweitinstanz und Obsidian-CLI) und wird hier nicht
kopiert. Der Treiber (`scripts/gui-smoke.ts`) hängt sich per Chrome DevTools Protocol an diese Instanz;
der Kopf der Datei hat die Befehle für dieses Repo. Danach den Stand bauen und einspielen:

```bash
OBSIDIAN_PLUGIN_DIR="$STAGING_VAULTS_DIR/vault-crews/.obsidian/plugins/vault-crews" npm run deploy
```

> **Das Fenster muss sichtbar sein — und zwar unverdeckt.** macOS meldet ein vollständig
> verdecktes Fenster als *occluded*, und Chromium macht daraus `visibilityState: "hidden"`;
> der DOM misst dann nichts. Der Treiber holt das verbundene Fenster selbst nach vorn
> (`requireVisible`) und bricht, wenn das nicht gelingt, **mit Ansage ab** (Exit-Code 2)
> statt rote Prüfpunkte zu melden — „ich konnte nicht messen" ist kein Befund am Prüfling.
> Der Treiber prüft außerdem vor dem ersten Punkt, dass `main.js` im Vault der gebaute
> Repo-Stand ist (`ladePluginNeu` mit `repoMainJs`); sonst bricht er ebenfalls ab.
> Ctrl-C räumt auf (Abbruch-Modul der Brücke): `data.json` zurück, neue Vault-Dateien weg,
> Bilanz mit „nichts gemessen“ für die nicht erreichten Punkte, Exit 130.

> **Den Exit-Code des Deploys prüfen.** `npm run deploy` baut mit `tsc --noEmit` davor:
> bei einem Typfehler bricht es ab und die **alte** `main.js` bleibt im Vault liegen — der
> Smoke misst dann einen Stand, den es im Quellbaum nicht mehr gibt. Genau so lief die
> erste Gegenprobe am 2026-08-17 grün durch, obwohl zwei Fixes ausgebaut waren.

Sind mehrere Vaults offen, ist `--vault` Pflicht; ohne ihn kann der Treiber im falschen
Fenster landen.

### Was gemessen wird

**Migration der `data.json`** (der Teil, der still Schaden anrichten könnte — der Treiber
spielt dafür eine Alt-Fassung ein und stellt danach das Original wieder her, mit
Rettungskopie daneben und byte-Vergleich im Protokoll):

1. Alte Endpunkt-Liste wird zu genau einem Eintrag
2. Das alte globale Modell landet in der Zeile und geht nicht verloren
3. Das globale Modellfeld existiert danach nicht mehr
4. Die übrigen Einstellungen überstehen die Migration
5. Ein kaputtes `data.json`-Feld reißt den Plugin-Start nicht mit

**Einstellungs-Tab** (was der Obsidian-Mock nicht sehen kann):

6. Einstellungs-Tab öffnet
7. Endpunkt-Zeile zeichnet ein URL-Feld
8. Endpunkt-Zeile zeichnet ein Schlüsselfeld
9. Endpunkt-Zeile zeichnet ein Modellfeld
10. Die Sperrliste ist ein mehrzeiliges Textfeld
11. Kein roher Übersetzungs-Schlüssel im Tab
12. Kein globales Feld „Standardmodell" mehr
13. Ein gesetzter Schlüssel führt zum Drittanbieter-Hinweis

### Durchläufe

| Datum | Obsidian | Ergebnis | Gegenprobe |
|---|---|---|---|
| 2026-08-17 | 1.13.7 | 13/13 | 12/13 bei ausgebautem `delete defaultModel`; 12/13 bei ausgebautem `Array.isArray`-Guard — je genau der betroffene Punkt. Der Sichtbarkeits-Guard brach bei verdecktem Fenster mit Exit 2 ab, ohne einen einzigen Prüfpunkt rot zu melden |

Der erste Lauf fand drei Befunde: zwei waren Mängel des Treibers (das Schlüsselfeld ist
`type="password"`, der Drittanbieter-Hinweis ist ein Icon statt Fließtext), einer war echt
— das abgeschaffte `defaultModel` blieb nach der Migration im Settings-Objekt liegen und
wurde bei jedem Speichern zurückgeschrieben. 409 grüne Tests sahen das nicht: sie prüften
die Migrationsfunktion, nicht den Ladepfad.

Die Gegenprobe deckte einen **vierten** auf, diesmal wieder im Treiber: der Punkt „kaputtes
`data.json`" fragte nur `endpoints.length > 0` — und ein String hat eine Länge. Er blieb
deshalb grün, während `endpoints` der rohe String `"http://kaputt"` war. Seitdem prüft er
`Array.isArray`.

## Von Hand — was der Treiber nicht abnimmt

Läuft **immer** gegen einen Vault, in dem Datenverlust verschmerzbar ist. Der
Snapshot-Undo braucht seit 0.2.0 kein git-Repo mehr.

1. Command **„Install example crews"** ausführen.
2. **BEIDE** Beispiel-Crews laufen lassen (Task-Triage **und** Daily-Briefing).
3. **Undo** testen (Panel → Verlauf → Rückgängig): geänderte Notizen im Vorzustand,
   erzeugte Notizen im Papierkorb. Der Snapshot-Ordner unter
   `.obsidian/plugins/vault-crews/undo/<runId>/` existiert nach dem Lauf und verschwindet
   nach dem Undo. Zusatz: eine Notiz **nach** dem Lauf editieren, dann Undo → die
   Konfliktwarnung muss erscheinen.
4. **(Optional) Gegen laufendes Ollama** (`http://localhost:11434/v1`): Endpunkt eintragen,
   eine Crew laufen lassen. Ohne `OLLAMA_ORIGINS` erscheint kein Live-Token-Ticker
   (Non-Stream-Fallback), das Ergebnis kommt trotzdem.
5. „Abort current run" **mitten in einem Lauf** auslösen — das Partial bleibt im Vault
   (undo-bar), `run.md` zeigt `status: aborted` + `error_kind: aborted`.
6. **Live-Token-Streaming ansehen** (seit 0.8.0): während eines Laufs zeigt die Sidebar
   Token-Text; der aufgeklappte „Thinking"-Bereich bleibt beim ersten Content-Token offen.
7. **Gehosteter Endpunkt** (seit 0.9.0, nur mit echtem Schlüssel prüfbar): zweite Zeile mit
   Schlüssel eintragen, lokalen Endpunkt ausschalten, eine Crew laufen lassen. Danach
   `run.md` gegenlesen — dort darf **kein** Schlüssel stehen.
   Seit 0.14.0 zusätzlich `data.json` ansehen: dort steht eine `secretId`, kein `apiKey` (der Schlüssel liegt im Schlüsselbund von Obsidian). Der Treiber misst beides (Abschnitt „Welle 15“).

## Was der Treiber an der Brücke gelernt hat

Zwei Härtungen sind aus diesem Lauf in `tools/obsidian-cdp/cdp.ts` zurückgeflossen und
wirken damit in allen Treibern:

- **`requireVisible(cdp)`** — die Sichtbarkeitsprüfung als Aufruf, den jeder Treiber als
  erste Zeile nach dem Verbinden macht. Bewusst nicht in `attachTo`: ein Treiber, der nur
  App-API-Zustände liest, kommt mit einem verdeckten Fenster aus.
- **Fristen auf `fetch` und den WebSocket-Aufbau.** Der `fetch` auf die Target-Liste war
  der einzige Pfad ganz ohne Frist — ein Treiber schwieg deshalb über fünf Minuten, ohne
  dass eine der anderen Fristen greifen konnte. Beim WebSocket bricht Node nach rund 15 s
  ohnehin selbst ab (gemessen: 15019 ms gegen einen Port, der annimmt und schweigt); dort
  verbessert die eigene Frist nur die Meldung.

Dazu ein Mangel, der im Treiber selbst blieb: der Abbruchpfad muss `cdp.close()` rufen.
Ein offener WebSocket hält den Node-Event-Loop am Leben — der Treiber gab seine
Abbruch-Meldung aus und lief danach weiter, von außen ununterscheidbar von einem Hänger.
