/** Maskiert API-Schlüssel in Text, der den Netzweg verlässt und im Vault oder auf dem
 *  Schirm landet.
 *
 *  Warum das hier ein eigenes Modul ist und nicht eine Zeile im Logger: vault-crews schreibt
 *  seine Läufe als Notizen IN den Vault (`run.md`, `state.json`) — und ein Vault wird
 *  gesynct. Ein Schlüssel, der einmal in einem Run-Log steht, ist danach überall dort, wo der
 *  Vault ist. Fehlerkörper sind der wahrscheinliche Weg dahin: manche Gateways spiegeln den
 *  gesendeten Authorization-Header in ihrer 401-Antwort.
 *
 *  Der Zwei-Nadeln-Fix unten kam am 2026-09-02 aus `llm-lab/src/core/redact_secrets.ts`
 *  zurueck — jene Datei ist eine Uebernahme DIESER hier (Stempel dort: 2026-08-22). Es sind
 *  also nicht zwei unabhaengige Instanzen, sondern eine Kopier-Kette; fuer die
 *  Kit-Extraktions-Schwelle zaehlt das als n=1. */
import type { EndpointConfig } from '../vendor/kit/endpoint_config';

const MASK = '••••';
/** Kürzer als das maskiert der Schlüssel als Teilstring gewöhnliche Wörter und macht die
 *  Meldung unlesbar — ein echter Token ist immer länger. */
const MIN_KEY_LENGTH = 8;
/** Fängt auch Schlüssel, die nirgends konfiguriert sind (durchgereichte Header-Echos). */
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(text: string, endpoints: EndpointConfig[]): string {
	if (text === '') return text;
	let out = text;
	for (const cfg of endpoints) {
		const key = cfg.apiKey?.trim();
		if (!key || key.length < MIN_KEY_LENGTH) continue;
		// Zwei Nadeln: die rohe Form (fuer direkte Aufrufe auf unserialisiertem Text) UND die
		// JSON-escapte Form (fuer den Aufruf ueber redactRunState — dort steht ein Schluessel
		// mit `"`, `\` oder Zeilenumbruch serialisiert anders da, und die rohe Suche faende ihn
		// nie). Nur zusaetzlich, nicht statt: keine der beiden ersetzt die andere, denn
		// JSON.stringify escapt Nicht-ASCII (Umlaute, CJK, Emoji) gerade NICHT — dort traegt
		// allein die Rohform.
		const escaped = JSON.stringify(key).slice(1, -1);
		const needles = escaped === key ? [key] : [key, escaped];
		for (const needle of needles) {
			out = out.replace(new RegExp(escapeRegExp(needle), 'g'), MASK);
		}
	}
	return out.replace(BEARER, `$1${MASK}`);
}

/** Redigiert ein ganzes Zustandsobjekt, bevor es den Prozess verlässt.
 *
 *  Bewusst über die Serialisierung statt Feld für Feld: der Lauf-Zustand wächst, und eine
 *  Liste zu pflegender Felder wäre genau die Art Buchhaltung, die beim nächsten neuen Feld
 *  still veraltet. Was ohnehin als JSON in den Vault geschrieben wird, lässt sich auch als
 *  JSON redigieren. */
export function redactRunState<T>(state: T, endpoints: EndpointConfig[]): T {
	return JSON.parse(redactSecrets(JSON.stringify(state), endpoints)) as T;
}
