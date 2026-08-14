/** Visueller Render-Beweis: die ECHTE RunPanelView aus dem Repo, in einem Chromium-Tab,
 *  mit dem echten styles.css — gespeist mit einem Token-Strom in der gemessenen Rate des
 *  echten Laufs (2.275 Think-Chunks / 47 s, dann 401 Content-Chunks / 8 s).
 *  Beantwortet, was Unit-Tests gegen den Obsidian-Mock NICHT beantworten können:
 *  ist der Text unter dem echten CSS sichtbar, wächst er, und scrollt er mit? */
import { installDomHelpers } from './obsidian-shim';
installDomHelpers();

import { RunPanelView } from '../../src/obsidian/panel';
import { setLang } from '../../src/vendor/kit/i18n';
import { registerI18n } from '../../src/i18n/strings';
import type { PanelHost, PanelTeam } from '../../src/obsidian/panel';
import type { RunEvent } from '../../src/core/ports';

registerI18n();
setLang('de');

const TEAMS: PanelTeam[] = [
	{ id: 'thinking-demo', name: 'Thinking-Demo', description: 'Reasoning-Lauf für den Think-Bereich-Smoke', lastRun: null },
	{ id: 'streaming-demo', name: 'Streaming-Demo', description: 'Langer Fließtext ohne Reasoning', lastRun: null },
];

const host: PanelHost = {
	getTeams: () => TEAMS,
	runCrew: (id) => { void start(id); },
	abortCurrentRun: () => { aborted = true; },
	undoLastRun: () => {},
	openLog: () => {},
	installExamples: () => {},
	getLastRunSummary: () => null,
	openCrewLog: () => {},
};

const mount = document.getElementById('panel') as HTMLElement;
const view = new RunPanelView({ contentEl: mount } as never, host);
void view.onOpen();

let aborted = false;

// Gemessene Kennzahlen des echten Laufs vom 2026-07-29 (qwen3.6-35b-a3b):
const Q = new URLSearchParams(location.search);
const THINK_CHUNKS = Number(Q.get('think') ?? 2275), THINK_MS = Number(Q.get('thinkMs') ?? 46_800), THINK_CHARS = 8602;
const CONTENT_CHUNKS = 401, CONTENT_MS = 8_000, CONTENT_CHARS = 1546;
const SPEED = Number(Q.get('speed') ?? 1);

const WORDS = ('Ich sortiere die Aufgaben nach Status und Priorität. Vortragsfolien steht auf aktiv und hoch, ' +
	'das ist der stärkste Kandidat. Zahnarzttermin liegt im Inbox, ist aber hoch priorisiert und braucht nur ' +
	'einen Anruf. Steuerbelege ist geplant und hoch. Fahrradreifen und Regal sind niedrig, die können warten. ' +
	'Ich prüfe noch, ob einer der Punkte eine Abhängigkeit hat, die ihn nach vorne zieht. ').split(' ');

function chunk(i: number, size: number): string {
	const out: string[] = [];
	let n = 0;
	while (n < size) { const w = WORDS[(i * 7 + out.length) % WORDS.length] ?? 'und'; out.push(w); n += w.length + 1; }
	return out.join(' ') + ' ';
}

function emit(e: RunEvent): void { view.handleEvent(e); }

async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms / SPEED)); }

async function start(teamId: string): Promise<void> {
	aborted = false;
	emit({ type: 'runStarted', runId: '2026-07-30-0015-' + teamId, teamId });
	emit({ type: 'taskStarted', taskId: 'collect', index: 0, total: 3 });
	await sleep(400);
	emit({ type: 'taskFinished', taskId: 'collect', status: 'ok' });
	emit({ type: 'taskStarted', taskId: 'denken', index: 1, total: 3 });

	const thinkPer = THINK_MS / THINK_CHUNKS;
	const thinkSize = Math.round(THINK_CHARS / THINK_CHUNKS);
	for (let i = 0; i < THINK_CHUNKS && !aborted; i++) {
		emit({ type: 'token', taskId: 'denken', text: chunk(i, Math.max(1, thinkSize)), isThink: true });
		if (i % 8 === 0) await sleep(thinkPer * 8);
	}
	const contPer = CONTENT_MS / CONTENT_CHUNKS;
	const contSize = Math.round(CONTENT_CHARS / CONTENT_CHUNKS);
	for (let i = 0; i < CONTENT_CHUNKS && !aborted; i++) {
		emit({ type: 'token', taskId: 'denken', text: chunk(i + 999, Math.max(1, contSize)), isThink: false });
		if (i % 8 === 0) await sleep(contPer * 8);
	}
	emit({ type: 'taskFinished', taskId: 'denken', status: 'ok' });
	emit({ type: 'taskStarted', taskId: 'denken-apply', index: 2, total: 3 });
	await sleep(300);
	emit({ type: 'taskFinished', taskId: 'denken-apply', status: 'ok' });
	emit({ type: 'runFinished', result: { runId: '2026-07-30-0015-' + teamId, status: 'ok', undoable: true, writes: 1, durationS: 57, errorTask: null, errorKind: null, alwaysOnThinker: false } });
}

// Messsonde für den Screenshot-Beweis: Textlänge + Scrollposition der Live-Knoten.
(window as unknown as { probe: () => unknown }).probe = () => {
	const think = document.querySelector('.vault-crews-live-think');
	const content = document.querySelector('.vault-crews-live-content');
	const details = document.querySelector('details.vault-crews-think');
	const summary = document.querySelector('.vault-crews-think summary');
	const empty = document.querySelector('.vault-crews-live-empty');
	const box = (el: Element | null): unknown => {
		if (el === null) return null;
		const r = el.getBoundingClientRect();
		const h = el as HTMLElement;
		return {
			chars: (el.textContent ?? '').length,
			visible: r.width > 0 && r.height > 0,
			rect: { w: Math.round(r.width), h: Math.round(r.height) },
			scroll: { top: Math.round(h.scrollTop), height: h.scrollHeight, client: h.clientHeight },
			atBottom: h.scrollHeight - h.scrollTop - h.clientHeight < 24,
			tail: (el.textContent ?? '').slice(-60),
		};
	};
	return {
		summaryText: summary?.textContent ?? null,
		detailsOpen: (details as HTMLDetailsElement | null)?.open ?? null,
		placeholder: empty?.textContent ?? null,
		think: box(think),
		content: box(content),
	};
};

(window as unknown as { openThink: () => void }).openThink = () => {
	const d = document.querySelector('details.vault-crews-think') as HTMLDetailsElement | null;
	if (d !== null) d.open = true;
};
(window as unknown as { startRun: () => void }).startRun = () => { void start('thinking-demo'); };
