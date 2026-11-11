// Task 18: Beispiel-Crews + Installer. Deckt drei Dinge ab (Brief, verbindlich):
// (1) Installer legt <root>/{agents,teams,runs}/ an und schreibt nur fehlende
//     Ziele — nie ein Overwrite, zweiter Lauf ist ein No-Op.
// (2) Die mitgelieferten Team-/Agent-Konstanten sind NICHT tot: sie durchlaufen
//     die ECHTEN Parser (parseTeamDef/parseAgentDef) unter den Plugin-Default-
//     Maxima und liefern ok:true — sonst wäre ein frisch installiertes Team beim
//     ersten Lauf bereits an PREFLIGHT gescheitert.
// (3) assets/examples/<sprache>/** (Klartext-Spiegel für's Repo) ist byte-identisch zu den
//     TS-Konstanten, die tatsächlich in main.js gebündelt werden — sonst drifted
//     der Repo-Spiegel unbemerkt vom Laufzeit-Inhalt weg.
// Alles läuft für Deutsch UND Englisch (der Installer wählt nach der Oberflächensprache),
// dazu zwei Zusicherungen für beide: kein Name aus dem privaten Vault des Maintainers und
// keine harten Zeilenumbrüche mitten im Absatz.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAgentDef, parseTeamDef } from '../../src/core/crew-parser';
import { buildDenylist } from '../../src/core/paths';
import type { RunLimits } from '../../src/core/types';
import type { Lang } from '../../src/vendor/kit/i18n';
import { installExampleCrews } from '../../src/obsidian/install-examples';
import { InMemoryVaultPort } from '../helpers/in-memory-vault';
// `yaml` (eemeli) ist reines Test-Tooling (devDependency) — parst die ECHTE YAML-Frontmatter
// der Beispiel-Teams (verschachtelte params/where/tasks), nie im Plugin-Bundle.
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = '_crews';
const LANGS: Lang[] = ['de', 'en'];

/** Pfade je Sprache, so wie sie der Installer anlegt (Reihenfolge egal). */
const PATHS: Record<Lang, string[]> = {
	de: [
		'agents/triage-analyst.md',
		'agents/briefing-autor.md',
		'teams/task-triage.md',
		'teams/daily-briefing.md',
		'runs/runs.base',
		'agents/notiz-tagger.md',
		'agents/reifegrad-tagger.md',
		'teams/notiz-tagger.md',
		'teams/reifegrad-tagger.md',
	],
	en: [
		'agents/triage-analyst.md',
		'agents/briefing-author.md',
		'teams/task-triage.md',
		'teams/daily-briefing.md',
		'runs/runs.base',
		'agents/note-tagger.md',
		'agents/maturity-tagger.md',
		'teams/note-tagger.md',
		'teams/maturity-tagger.md',
	],
};

/** Je Sprache: Feldnamen, Ordner und Tagesnotizen-Ziel, die die Beispiele tragen. */
const SPEC: Record<Lang, {
	tasks: string; daily: string; notes: string; triageKeys: string[]; tagKeys: string[]; matKeys: string[];
	agentIds: string[]; matAgent: string; tagAgent: string; matTeam: string; tagTeam: string; briefAgent: string;
}> = {
	de: { tasks: 'Aufgaben', daily: 'Tagesnotizen', notes: 'Notizen', triageKeys: ['priority', 'kontext', 'projekt', 'period'], tagKeys: ['tags'], matKeys: ['reifegrad'], agentIds: ['triage-analyst', 'briefing-autor', 'notiz-tagger', 'reifegrad-tagger'], matAgent: 'reifegrad-tagger', tagAgent: 'notiz-tagger', matTeam: 'reifegrad-tagger', tagTeam: 'notiz-tagger', briefAgent: 'briefing-autor' },
	en: { tasks: 'Tasks', daily: 'Daily', notes: 'Notes', triageKeys: ['priority', 'context', 'project', 'period'], tagKeys: ['tags'], matKeys: ['maturity'], agentIds: ['triage-analyst', 'briefing-author', 'note-tagger', 'maturity-tagger'], matAgent: 'maturity-tagger', tagAgent: 'note-tagger', matTeam: 'maturity-tagger', tagTeam: 'note-tagger', briefAgent: 'briefing-author' },
};

// Plugin-Default-Maxima (DEFAULT_SETTINGS aus src/obsidian/settings.ts, in RunLimits-
// Form gebracht) — genau das, was ein frisch installiertes Plugin einem frisch
// installierten Team entgegensetzt. Nur maxWrites ist für parseTeamDef relevant.
const DEFAULT_MAXIMA: RunLimits = {
	maxWrites: 10,
	maxLlmCalls: 999,
	wallClockMs: 600_000,
	maxNoteBytes: 65_536,
	callTimeoutMs: 300_000,
	stallTimeoutMs: 60_000,
};
const DENYLIST = buildDenylist('.obsidian', '_crews');

/** Der Inhalt der Beispiel-Dateien je Sprache, so wie er nach der Installation im Vault steht
 *  (Pfad relativ zur Crew-Wurzel). Einmal je Sprache gelesen, damit die Tests synchron bleiben. */
const INSTALLIERT = new Map<Lang, Map<string, string>>();
beforeAll(async () => {
	for (const lang of LANGS) {
		const vault = new InMemoryVaultPort();
		const { created } = await installExampleCrews(vault, ROOT, lang);
		const inhalte = new Map<string, string>();
		for (const pfad of created) inhalte.set(pfad.slice(ROOT.length + 1), await vault.read(pfad));
		INSTALLIERT.set(lang, inhalte);
	}
});

function asset(lang: Lang, path: string): string {
	const text = INSTALLIERT.get(lang)?.get(path);
	if (text === undefined) throw new Error(`kein Beispiel ${lang}/${path}`);
	return text;
}

/** Frontmatter-Block + Body aus einer Team-/Agent-Note extrahieren, per echtem
 *  YAML-Parser (`yaml`) — das kleine YAML-Subset aus in-memory-vault.ts reicht für
 *  verschachtelte Team-Definitionen (params/where/tasks) explizit nicht aus. */
function splitFrontmatter(raw: string): { fm: Record<string, unknown> | null; body: string } {
	if (!raw.startsWith('---\n')) return { fm: null, body: raw };
	const end = raw.indexOf('\n---\n', 4);
	if (end < 0) return { fm: null, body: raw };
	const block = raw.slice(4, end);
	const body = raw.slice(end + 5);
	const fm = parseYaml(block);
	return { fm: (fm ?? null) as Record<string, unknown> | null, body };
}

describe.each(LANGS)('Beispiel-Crews (%s)', (lang) => {
	const spec = SPEC[lang];
	const paths = PATHS[lang];
	const knownAgents = spec.agentIds;

	describe('installExampleCrews', () => {
		it('installiert alle Beispiel-Dateien in einen leeren Vault', async () => {
			const vault = new InMemoryVaultPort();
			const result = await installExampleCrews(vault, ROOT, lang);

			expect(result.created.sort()).toEqual(paths.map((p) => `${ROOT}/${p}`).sort());
			expect(result.skipped).toEqual([]);
			for (const p of paths) {
				expect(await vault.exists(`${ROOT}/${p}`)).toBe(true);
				expect(await vault.read(`${ROOT}/${p}`)).toBe(asset(lang, p));
			}
		});

		it('ist idempotent: zweiter Lauf überschreibt nichts, alles landet in skipped', async () => {
			const vault = new InMemoryVaultPort();
			await installExampleCrews(vault, ROOT, lang);
			// Nutzer hat eine Datei zwischenzeitlich editiert — Beweis, dass der zweite
			// Lauf sie NICHT zurücksetzt (das "nie überschreiben"-Versprechen aus dem Brief).
			await vault.modify(`${ROOT}/teams/task-triage.md`, '### vom User editiert ###');

			const second = await installExampleCrews(vault, ROOT, lang);

			expect(second.created).toEqual([]);
			expect(second.skipped.sort()).toEqual(paths.map((p) => `${ROOT}/${p}`).sort());
			expect(await vault.read(`${ROOT}/teams/task-triage.md`)).toBe('### vom User editiert ###');
		});

		it('installiert unter einem beliebigen, konfigurierten Wurzelordner', async () => {
			const vault = new InMemoryVaultPort();
			const result = await installExampleCrews(vault, 'Meine Crews', lang);
			expect(result.created.sort()).toEqual(paths.map((p) => `Meine Crews/${p}`).sort());
		});
	});

	describe('nicht tot (echte Parser, Plugin-Default-Maxima)', () => {
		it.each(paths.filter((p) => p.startsWith('agents/')))('%s parst über parseAgentDef mit thinking:off', (p) => {
			const { fm, body } = splitFrontmatter(asset(lang, p));
			const r = parseAgentDef(`_crews/${p}`, fm, body);
			expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
			if (!r.ok) return;
			expect(r.value.id).toBe(p.replace(/^agents\//, '').replace(/\.md$/, ''));
			expect(r.value.systemPrompt.length).toBeGreaterThan(0);
			// Regression: 'auto' laesst Reasoning-Modelle (z. B. qwen3.6) das gesamte
			// max_tokens-Budget in <think> verbrennen -> leerer Output -> invalid_output
			// (Smoke-Test-Fund). Strukturierte-Output-Agenten brauchen thinking:off.
			expect(r.value.thinking).toBe('off');
		});

		it('task-triage.md parst über parseTeamDef', () => {
			const { fm } = splitFrontmatter(asset(lang, 'teams/task-triage.md'));
			const r = parseTeamDef('_crews/teams/task-triage.md', fm, { knownAgents, maxima: DEFAULT_MAXIMA, denylist: DENYLIST });
			expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
			if (!r.ok) return;
			expect(r.value.id).toBe('task-triage');
			expect(r.value.maxWrites).toBeLessThanOrEqual(DEFAULT_MAXIMA.maxWrites);
			expect(r.value.tasks.map((t) => t.id)).toEqual(['collect', 'analyse', 'apply']);
			const applyTask = r.value.tasks[2];
			expect(applyTask).toMatchObject({ kind: 'actions', allowedActions: ['frontmatter.patch'], allowedKeys: spec.triageKeys });
			// Weiche Felder ja, harte Felder (status/type) NIE (Brief-Vorgabe).
			if (applyTask?.kind === 'actions') {
				expect(applyTask.allowedKeys).not.toContain('status');
				expect(applyTask.allowedKeys).not.toContain('type');
			}
		});

		it('daily-briefing.md parst über parseTeamDef', () => {
			const { fm } = splitFrontmatter(asset(lang, 'teams/daily-briefing.md'));
			const r = parseTeamDef('_crews/teams/daily-briefing.md', fm, { knownAgents, maxima: DEFAULT_MAXIMA, denylist: DENYLIST });
			expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
			if (!r.ok) return;
			expect(r.value.id).toBe('daily-briefing');
			expect(r.value.tasks.map((t) => t.id)).toEqual(['collect', 'briefing', 'apply']);
			expect(r.value.tasks[1]).toMatchObject({ kind: 'llm', agent: spec.briefAgent, output: { family: 'section.write', maxChars: 16_000 } });
			const applyTask = r.value.tasks[2];
			expect(applyTask).toMatchObject({ kind: 'actions', allowedActions: ['section.replace'], createIfMissing: true });
			if (applyTask?.kind === 'actions') {
				// {{today}} ist unexpandiert im geparsten Team — Expansion passiert erst zur
				// Laufzeit im Orchestrator (paths.expandTarget), nie beim Parsen.
				expect(applyTask.target).toBe(`${spec.daily}/{{today}}.md`);
			}
		});

		it.each([
			['tag', 'tagTeam', 'tagAgent', 'tagKeys'],
			['mat', 'matTeam', 'matAgent', 'matKeys'],
		] as const)('%s-Team parst und nutzt frontmatter.set', (_n, teamKey, agentKey, keysKey) => {
			const id = spec[teamKey];
			const keys = spec[keysKey];
			const { fm } = splitFrontmatter(asset(lang, `teams/${id}.md`));
			const r = parseTeamDef(`_crews/teams/${id}.md`, fm, { knownAgents, maxima: DEFAULT_MAXIMA, denylist: DENYLIST });
			expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
			if (!r.ok) return;
			expect(r.value.id).toBe(id);
			expect(r.value.maxWrites).toBeLessThanOrEqual(DEFAULT_MAXIMA.maxWrites);
			const llmTask = r.value.tasks.find((t) => t.kind === 'llm');
			expect(llmTask).toMatchObject({ kind: 'llm', agent: spec[agentKey], output: { family: 'frontmatter.set', allowedKeys: keys } });
			// Der apply-actions-Task braucht sein EIGENES allowed_keys (Ausführungs-Gate,
			// wird NICHT vom output:-Block des llm-Tasks vererbt). Fehlt es, setzt der Parser
			// allowedKeys:null → action-executor macht daraus eine leere Allowlist → jeder
			// vorgeschlagene Key wird abgelehnt → die Crew schreibt zur Laufzeit NICHTS.
			const applyTask = r.value.tasks.find((t) => t.kind === 'actions');
			expect(applyTask).toMatchObject({ kind: 'actions', allowedActions: ['frontmatter.patch'], allowedKeys: keys });
		});

		it('jedes Team zeigt Ordner und Schreibfreigabe auf dieselbe neutrale Wurzel', () => {
			const folders: Record<string, [string, string]> = {
				'task-triage': [spec.tasks, spec.tasks],
				'daily-briefing': [spec.tasks, spec.daily],
				[spec.tagTeam]: [spec.notes, spec.notes],
				[spec.matTeam]: [spec.notes, spec.notes],
			};
			for (const [id, [collectFolder, writeFolder]] of Object.entries(folders)) {
				const { fm } = splitFrontmatter(asset(lang, `teams/${id}.md`));
				const tasks = (fm?.tasks ?? []) as { kind: string; params?: { folder?: string } }[];
				expect(tasks.find((t) => t.kind === 'collector')?.params?.folder, id).toBe(collectFolder);
				expect(fm?.write_scope, id).toEqual([expect.stringMatching(new RegExp(`^${writeFolder}/`))]);
			}
		});
	});

	describe(`assets/examples/${lang}/** ist byte-identisch zu den TS-Konstanten`, () => {
		it.each(paths)('%s', (p) => {
			// Der Spiegel legt runs.base ohne den Ordner `runs/` ab.
			const onDisk = readFileSync(join(REPO_ROOT, 'assets', 'examples', lang, p.replace(/^runs\//, '')), 'utf8');
			expect(onDisk).toBe(asset(lang, p));
		});
	});

	describe('Inhalt', () => {
		// Namen aus dem privaten Vault des Maintainers (Ordner mit Nummernpräfix, Vault-Name,
		// Pallas-Konvention) gehören in kein ausgeliefertes Beispiel (Welle 32).
		const PRIVAT = /\d\d_[A-Za-zÄÖÜäöü]|Chronos|Zettel|Pallas|periodic-notes|daily-notes\.json/;

		it.each(paths)('%s trägt keinen Namen aus einem privaten Vault', (p) => {
			expect(asset(lang, p)).not.toMatch(PRIVAT);
		});

		it.each(paths.filter((p) => p.endsWith('.md')))('%s hat keine harten Zeilenumbrüche mitten im Absatz', (p) => {
			// Absatz = Folge nicht-leerer Fließtextzeilen. Listen-, Überschriften-, Tabellen-, Code-
			// und YAML-Zeilen zählen nicht; `instruction: |`-Blöcke werden über den geparsten Text geprüft.
			const { fm, body } = splitFrontmatter(asset(lang, p));
			const texte = [body];
			const tasks = (fm?.tasks ?? []) as { instruction?: string }[];
			for (const t of tasks) if (typeof t.instruction === 'string') texte.push(t.instruction);
			const istFliesstext = (l: string): boolean => l.trim() !== '' && !/^\s*([#>|*-]|\d+\.|```|<!--|---)/.test(l) && !/^[a-z_]+:/.test(l);
			for (const text of texte) {
				const zeilen = text.split('\n');
				for (let i = 0; i + 1 < zeilen.length; i += 1) {
					const a = zeilen[i] ?? '';
					const b = zeilen[i + 1] ?? '';
					expect(istFliesstext(a) && istFliesstext(b), `${p}: „${a.slice(0, 40)}…“ geht ohne Leerzeile weiter`).toBe(false);
				}
			}
		});
	});
});
