import { describe, expect, it } from 'vitest';
import { statusKindKey, warnRuleKey } from '../../src/obsidian/endpoint-labels';
import { EN } from '../../src/i18n/strings';

describe('endpoint-labels', () => {
	// Der Punkt dieser Tests ist nicht die Zeichenkette, sondern dass jeder Schluessel,
	// den die Zuordnung erzeugen kann, in der String-Tabelle auch existiert — sonst
	// erscheint in der Oberflaeche der rohe Key.
	it('erzeugt fuer jeden Status-Kind einen Schluessel, den es gibt', () => {
		for (const kind of ['ok', 'refused', 'unknown-host', 'timeout', 'not-an-llm-api', 'unknown'] as const) {
			expect(EN).toHaveProperty(statusKindKey(kind));
		}
	});

	it('erzeugt fuer die Warn-Regeln Schluessel, die es gibt', () => {
		for (const rule of ['no-scheme', 'trailing-v1', 'trailing-slash']) {
			const key = warnRuleKey(rule);
			if (key in EN) expect(EN).toHaveProperty(key);
		}
		expect(warnRuleKey('no-scheme')).toBe('settings.endpoint.warn.no-scheme');
	});
});
