/** Minimal-Shim für den `obsidian`-Import, damit die ECHTE panel.ts in einem normalen
 *  Chromium-Tab läuft. Die DOM-Helper sind Obsidians Prototype-Erweiterungen, hier auf
 *  echten DOM-Knoten nachgebaut (Obsidian macht genau das — deshalb ist das Rendering
 *  hier dasselbe wie dort; was NICHT abgedeckt ist: Obsidians eigene Themes/Layout). */

interface ElOpts { cls?: string; text?: string; attr?: Record<string, string> }

function applyOpts(el: HTMLElement, o?: ElOpts): HTMLElement {
	if (o?.cls !== undefined) el.className = o.cls;
	if (o?.text !== undefined) el.textContent = o.text;
	if (o?.attr !== undefined) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
	return el;
}

export function installDomHelpers(): void {
	const p = HTMLElement.prototype as unknown as Record<string, unknown>;
	p.createEl = function (this: HTMLElement, tag: string, o?: ElOpts): HTMLElement {
		const el = document.createElement(tag);
		this.appendChild(el);
		return applyOpts(el, o);
	};
	p.createDiv = function (this: HTMLElement, o?: ElOpts): HTMLElement {
		return (this as unknown as { createEl: (t: string, o?: ElOpts) => HTMLElement }).createEl('div', o);
	};
	p.createSpan = function (this: HTMLElement, o?: ElOpts): HTMLElement {
		return (this as unknown as { createEl: (t: string, o?: ElOpts) => HTMLElement }).createEl('span', o);
	};
	// Obsidians Alias für setAttribute (panel.ts nutzt ihn fürs open-Attribut des <details>).
	p.setAttr = function (this: HTMLElement, k: string, v: string): void { this.setAttribute(k, v); };
	p.setText = function (this: HTMLElement, t: string): void { this.textContent = t; };
	p.appendText = function (this: HTMLElement, t: string): void { this.appendChild(document.createTextNode(t)); };
	p.empty = function (this: HTMLElement): void { while (this.firstChild) this.removeChild(this.firstChild); };
	p.addClass = function (this: HTMLElement, ...c: string[]): void { this.classList.add(...c); };
	p.removeClass = function (this: HTMLElement, ...c: string[]): void { this.classList.remove(...c); };
	p.toggleClass = function (this: HTMLElement, c: string, on: boolean): void { this.classList.toggle(c, on); };
}

export type WorkspaceLeaf = { contentEl: HTMLElement };

export class ItemView {
	contentEl: HTMLElement;
	containerEl: HTMLElement;
	constructor(leaf: WorkspaceLeaf) {
		this.contentEl = leaf.contentEl;
		this.containerEl = leaf.contentEl;
	}
	registerEvent(): void { /* nicht gebraucht */ }
	addAction(): void { /* nicht gebraucht */ }
}

export class Notice { constructor(public message: string) { console.warn('[Notice]', message); } }
export const Platform = { isDesktop: true, isMobile: false };
