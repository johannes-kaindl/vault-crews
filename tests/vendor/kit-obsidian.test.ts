// Smoke-Tests der vendorten obsidian-gekoppelten Kit-Module (src/vendor/kit-obsidian/):
// sichern die hier genutzten Verträge ab, damit ein künftiges manuelles Nachziehen der
// Vendor-Kopien Abweichungen sofort zeigt. Gegenstück zu tests/vendor/kit.test.ts für
// die pure Schicht (UI-STANDARD §9 zieht die Grenze am obsidian-Import).
import { describe, expect, it } from 'vitest';
import { ButtonComponent, Modal, makeFakeApp } from '../__mocks__/obsidian';
import { confirmAction } from '../../src/vendor/kit-obsidian/confirm';

interface FakeEl { className: string; tagName: string; textContent: string; children: FakeEl[]; __component?: ButtonComponent; }
interface OpenModal { contentEl: FakeEl; titleEl: FakeEl; onClose(): void; }

/** confirmAction kapselt seine Modal-Klasse — Modal.__last ist der Zugriffsweg.
 *  Button-Reihenfolge im modal-button-container: [0] Cancel, [1] Confirm (UI-STANDARD §2). */
function open(opts: Parameters<typeof confirmAction>[1]) {
	const p = confirmAction(makeFakeApp() as never, opts);
	const modal = Modal.__last as unknown as OpenModal;
	const box = modal.contentEl.children.find((c) => c.className === 'modal-button-container');
	expect(box).toBeTruthy();
	const [cancel, confirm] = (box as FakeEl).children.map((c) => c.__component as ButtonComponent);
	return { p, modal, cancel, confirm };
}

describe('vendored confirmAction', () => {
	it('resolved true nur bei explizitem Bestätigen', async () => {
		const { p, confirm } = open({ message: 'Wirklich?' });
		confirm.clickCB?.();
		await expect(p).resolves.toBe(true);
	});

	it('resolved false bei Cancel', async () => {
		const { p, cancel } = open({ message: 'Wirklich?' });
		cancel.clickCB?.();
		await expect(p).resolves.toBe(false);
	});

	// Ohne das haengt das Promise bei Esc oder Klick daneben — der Undo-Dialog waere tot.
	it('resolved false, wenn der Dialog ohne Klick geschlossen wird', async () => {
		const { p, modal } = open({ message: 'Wirklich?' });
		modal.onClose();
		await expect(p).resolves.toBe(false);
	});

	// Der Undo-Dialog uebergibt seine Zeilen als Array (Team, Zeit, Dateien, Warnungen).
	it('rendert ein message-Array als je einen Absatz', async () => {
		const { p, cancel, modal } = open({ title: 'Titel', message: ['eins', 'zwei', 'drei'] });
		const paras = modal.contentEl.children.filter((c) => c.tagName === 'P');
		expect(paras.map((c) => c.textContent)).toEqual(['eins', 'zwei', 'drei']);
		expect(modal.titleEl.textContent).toBe('Titel');
		cancel.clickCB?.();
		await p;
	});

	// vault-crews' Undo ist wiederherstellend, nicht zerstoerend: warning:false muss den
	// CTA-Knopf ergeben, nicht den destruktiven (Kit-Default ist destruktiv).
	it('warning:false ergibt den CTA-Button, Default den destruktiven', async () => {
		const a = open({ message: 'x', warning: false });
		expect(a.confirm.ctaSet).toBe(true);
		expect(a.confirm.destructiveSet || a.confirm.warningSet).toBe(false);
		a.cancel.clickCB?.();
		await a.p;

		const b = open({ message: 'x' });
		expect(b.confirm.ctaSet).toBe(false);
		expect(b.confirm.destructiveSet || b.confirm.warningSet).toBe(true);
		b.cancel.clickCB?.();
		await b.p;
	});

	it('uebernimmt die Button-Beschriftungen', async () => {
		const { p, cancel, confirm } = open({ message: 'x', confirmLabel: 'Rückgängig', cancelLabel: 'Abbrechen' });
		expect(confirm.textValue).toBe('Rückgängig');
		expect(cancel.textValue).toBe('Abbrechen');
		cancel.clickCB?.();
		await p;
	});
});
