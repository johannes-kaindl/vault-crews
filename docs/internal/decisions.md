# Entscheidungen in vault-crews — das Warum

Verdichtete Design-Essenz zu den Regeln im Kern (`AGENTS.md`) und in `.claude/rules/`. Die Herleitungen liegen im Cockpit des Maintainers (CORE-META-14). Vor dem Übernehmen einer Altentscheidung gilt Johannes' Regel: Grund aufsuchen, messen, ob er heute trägt, Ergebnis melden.

## Statusklassen: die Naht zwischen Kit und `t()` (2026-08-17, 0.9.1)

Der Wortlaut stammt aus der `AGENTS.md` vor der Kürzung (Welle 25) und beschreibt den Stand vor Kit 0.56.0; was heute gilt, steht in `.claude/rules/statustexte-und-fehlerklassen.md`.

**Statusklassen kommen aus dem Kit, die Sätze dazu aus diesem Repo — die Naht ist ungesichert (erledigt 2026-08-17, 0.9.1, bleibt als Begründung stehen).** Der vendorte `endpoint_diagnostics.ts` führt die Klassen (Kit 0.24.0), dieses Repo formuliert sie selbst über `t()`. Fällt dabei ein Schlüssel aus, ist das **unsichtbar**: `t()` fällt bei unbekanntem Schlüssel auf den **Schlüssel** zurück, nicht auf EN — in der Oberfläche stünde ``settings.endpoint.status.unauthorized`` und sähe aus wie ein plausibler String, nicht wie ein Fehler. Genau das war bis 0.9.1 der Fall, und getroffen wurde ausgerechnet der Fall, für den die Klasse eingeführt wurde: ein gehosteter Endpunkt mit fehlendem oder falschem API-Schlüssel (401/403). Gefunden hat es der Consumer-Sweep, nicht das Gate.

## Kein `json_schema`-API-Modus

Der Modus bricht an LM Studio bei Reasoning-Modellen. Stattdessen läuft prompt-basiertes JSON mit `output-validator` (constrain-then-verify).

## Vendoring statt Git-Abhängigkeiten

Die Community-Review-Sandbox bricht an `git+https`-npm-Dependencies (Lesson 2026-07-01), deshalb liegen Kit-Module als Kopie unter `src/vendor/`. Das Werkzeug ist das zentrale `kit-sync` im Dach, die Pins stehen in `tools/kit-sync.json`.

## Reparatur-Call mit History (b36baff) gegen den alten ohne Ausgangs-Prompt: gemessen 2026-11-14

**Der Reparatur-Call trägt die History, weil ohne sie ein kleines Modell das Format nicht mehr kennt.** Gemessen an `google/gemma-4-e4b` auf LM Studio (MLX 4bit, ohne `reasoning_effort` gesendet, `temperature` 0.1, `max_tokens` 3000), drei künstlich ungültige Ausgangsantworten, je Fall und Arm vier Reparaturen, zusammen 24 Anrufe, alle HTTP 200, keine Abbrüche mit `finish_reason: length`. Alt (nur „Antworte erneut“ plus die fehlerhafte Ausgabe plus die Fehlerliste, ohne Ausgangs-Prompt): 4 von 12 gültig. Neu (`buildRetryMessages` aus dem Kit, mit History): 12 von 12 gültig. Nach Fall: Prosa statt JSON alt 0/4, neu 4/4; falsche Form (`results` statt `items`) alt 0/4, neu 4/4; Feld außerhalb der Freigabe (`status`) alt 4/4, neu 4/4. Der alte Arm scheitert genau dort, wo das Modell das Format nur aus dem Ausgangs-Prompt kennen kann; beim dritten Fall steht die Regel in der Fehlermeldung selbst („nicht in allowed_keys“), da genügt sie. Die Verhaltensänderung aus b36baff ist damit belegt, nicht nur im Test der Nachrichten.

**Die Frage nach der englischen Einstiegszeile der Kit-Nachricht ist beantwortet, soweit dieses Modell reicht: sie senkt die Erfolgsrate nicht messbar.** Der neue Arm besteht aus der englischen Einstiegszeile des Kits und der deutschen Aufforderung dahinter und erreicht 12 von 12 (Obergrenze, nichts zu senken). Grenzen: Die Arme unterscheiden sich in der History und im Einstieg zugleich, ein Arm mit History und deutschem Einstieg wurde nicht gefahren; ein Unterschied unterhalb der Obergrenze ist daher mit diesen Zahlen nicht auszuschließen, nur dass er bei diesem Modell keinen Fehlschlag verursacht. Gemessen ist ein Modell einer Größe, ein Backend, ein Abschnitt (ein Prompt-Typ `frontmatter.set`); kleinere oder stärker quantisierte Modelle sind nicht gemessen. Gemma 4 lässt sich auf LM Studio nicht abschalten (im Kit denkt `off` dort auf der Stufe `low`), „thinking off“ heißt hier: kein `reasoning_effort` gesendet; gezählt wurde das Denken nicht, `length` trat nie auf.

**Konsequenz:** keine Änderung am Code auf Verdacht. Eine Option für den Einstiegssatz im Kit wäre nur nötig, wenn ein Modell mit der englischen Zeile scheitert; das wurde nicht beobachtet.
