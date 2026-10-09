// Kit-CSS-Wächter (obsidian-kit MIGRATION § 0.51.0): jede gevendorte `*_CSS`-Konstante steht wortgleich in styles.css.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findVendoredCss, missingKitCss } from './kit/kit-css';

const VENDOR_DIR = 'src/vendor/kit-obsidian';

describe('Kit-CSS in styles.css', () => {
	it('der Wächter findet gevendorte Konstanten', () => {
		expect(findVendoredCss(VENDOR_DIR).length).toBeGreaterThan(0);
	});

	it('jede gevendorte Konstante steht wortgleich in styles.css', () => {
		expect(missingKitCss(VENDOR_DIR, readFileSync('styles.css', 'utf8'))).toEqual([]);
	});
});
