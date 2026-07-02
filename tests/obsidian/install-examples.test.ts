// Task 18: Beispiel-Crews + Installer. Deckt drei Dinge ab (Brief, verbindlich):
// (1) Installer legt <root>/{agents,teams,runs}/ an und schreibt nur fehlende
//     Ziele — nie ein Overwrite, zweiter Lauf ist ein No-Op.
// (2) Die mitgelieferten Team-/Agent-Konstanten sind NICHT tot: sie durchlaufen
//     die ECHTEN Parser (parseTeamDef/parseAgentDef) unter den Plugin-Default-
//     Maxima und liefern ok:true — sonst wäre ein frisch installiertes Team beim
//     ersten Lauf bereits an PREFLIGHT gescheitert.
// (3) assets/examples/** (Klartext-Spiegel für's Repo) ist byte-identisch zu den
//     TS-Konstanten, die tatsächlich in main.js gebündelt werden — sonst drifted
//     der Repo-Spiegel unbemerkt vom Laufzeit-Inhalt weg.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAgentDef, parseTeamDef } from '../../src/core/crew-parser';
import { buildDenylist } from '../../src/core/paths';
import type { RunLimits } from '../../src/core/types';
import {
	BRIEFING_AUTOR_AGENT,
	DAILY_BRIEFING_TEAM,
	RUNS_BASE,
	TASK_TRIAGE_TEAM,
	TRIAGE_ANALYST_AGENT,
} from '../../src/obsidian/example-assets';
import { installExampleCrews } from '../../src/obsidian/install-examples';
import { InMemoryVaultPort } from '../helpers/in-memory-vault';
// js-yaml ist reines Test-Tooling (devDependency) — parst die ECHTE YAML-Frontmatter
// der Beispiel-Teams (verschachtelte params/where/tasks), nie im Plugin-Bundle.
import * as yaml from 'js-yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = '_crews';

const EXPECTED_PATHS = [
	`${ROOT}/agents/triage-analyst.md`,
	`${ROOT}/agents/briefing-autor.md`,
	`${ROOT}/teams/task-triage.md`,
	`${ROOT}/teams/daily-briefing.md`,
	`${ROOT}/runs/runs.base`,
];

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
const KNOWN_AGENTS = ['triage-analyst', 'briefing-autor'];
const DENYLIST = buildDenylist('.obsidian', '_crews');

/** Frontmatter-Block + Body aus einer Team-/Agent-Note extrahieren, per echtem
 *  YAML-Parser (js-yaml) — das kleine YAML-Subset aus in-memory-vault.ts reicht für
 *  verschachtelte Team-Definitionen (params/where/tasks) explizit nicht aus. */
function splitFrontmatter(raw: string): { fm: Record<string, unknown> | null; body: string } {
	if (!raw.startsWith('---\n')) return { fm: null, body: raw };
	const end = raw.indexOf('\n---\n', 4);
	if (end < 0) return { fm: null, body: raw };
	const block = raw.slice(4, end);
	const body = raw.slice(end + 5);
	const fm = yaml.load(block);
	return { fm: (fm ?? null) as Record<string, unknown> | null, body };
}

describe('installExampleCrews', () => {
	it('installiert alle Beispiel-Dateien in einen leeren Vault', async () => {
		const vault = new InMemoryVaultPort();
		const result = await installExampleCrews(vault, ROOT);

		expect(result.created.sort()).toEqual([...EXPECTED_PATHS].sort());
		expect(result.skipped).toEqual([]);
		for (const path of EXPECTED_PATHS) {
			expect(await vault.exists(path)).toBe(true);
		}
		expect(await vault.read(`${ROOT}/agents/triage-analyst.md`)).toBe(TRIAGE_ANALYST_AGENT);
		expect(await vault.read(`${ROOT}/agents/briefing-autor.md`)).toBe(BRIEFING_AUTOR_AGENT);
		expect(await vault.read(`${ROOT}/teams/task-triage.md`)).toBe(TASK_TRIAGE_TEAM);
		expect(await vault.read(`${ROOT}/teams/daily-briefing.md`)).toBe(DAILY_BRIEFING_TEAM);
		expect(await vault.read(`${ROOT}/runs/runs.base`)).toBe(RUNS_BASE);
	});

	it('ist idempotent: zweiter Lauf überschreibt nichts, alles landet in skipped', async () => {
		const vault = new InMemoryVaultPort();
		await installExampleCrews(vault, ROOT);
		// Nutzer hat eine Datei zwischenzeitlich editiert — Beweis, dass der zweite
		// Lauf sie NICHT zurücksetzt (das "nie überschreiben"-Versprechen aus dem Brief).
		await vault.modify(`${ROOT}/teams/task-triage.md`, '### vom User editiert ###');

		const second = await installExampleCrews(vault, ROOT);

		expect(second.created).toEqual([]);
		expect(second.skipped.sort()).toEqual([...EXPECTED_PATHS].sort());
		expect(await vault.read(`${ROOT}/teams/task-triage.md`)).toBe('### vom User editiert ###');
	});

	it('installiert unter einem beliebigen, konfigurierten Wurzelordner', async () => {
		const vault = new InMemoryVaultPort();
		const result = await installExampleCrews(vault, 'Meine Crews');
		expect(result.created.sort()).toEqual([
			'Meine Crews/agents/briefing-autor.md',
			'Meine Crews/agents/triage-analyst.md',
			'Meine Crews/runs/runs.base',
			'Meine Crews/teams/daily-briefing.md',
			'Meine Crews/teams/task-triage.md',
		]);
	});
});

describe('Beispiel-Agenten/-Teams sind nicht tot (echte Parser, Plugin-Default-Maxima)', () => {
	it('triage-analyst.md parst über parseAgentDef', () => {
		const { fm, body } = splitFrontmatter(TRIAGE_ANALYST_AGENT);
		const r = parseAgentDef('_crews/agents/triage-analyst.md', fm, body);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(r.value.id).toBe('triage-analyst');
		expect(r.value.systemPrompt.length).toBeGreaterThan(0);
		// Regression: 'auto' laesst Reasoning-Modelle (z. B. qwen3.6) das gesamte
		// max_tokens-Budget in <think> verbrennen -> leerer Output -> invalid_output
		// (Smoke-Test-Fund). Strukturierte-Output-Agenten brauchen thinking:off.
		expect(r.value.thinking).toBe('off');
	});

	it('briefing-autor.md parst über parseAgentDef', () => {
		const { fm, body } = splitFrontmatter(BRIEFING_AUTOR_AGENT);
		const r = parseAgentDef('_crews/agents/briefing-autor.md', fm, body);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(r.value.id).toBe('briefing-autor');
		// Regression: siehe triage-analyst.md oben - beide Beispiel-Agenten muessen
		// thinking:off tragen, sonst produzieren Reasoning-Modelle keinen Output.
		expect(r.value.thinking).toBe('off');
	});

	it('task-triage.md parst über parseTeamDef unter den Plugin-Default-Maxima', () => {
		const { fm } = splitFrontmatter(TASK_TRIAGE_TEAM);
		const r = parseTeamDef('_crews/teams/task-triage.md', fm, {
			knownAgents: KNOWN_AGENTS,
			maxima: DEFAULT_MAXIMA,
			denylist: DENYLIST,
		});
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(r.value.id).toBe('task-triage');
		expect(r.value.maxWrites).toBeLessThanOrEqual(DEFAULT_MAXIMA.maxWrites);
		expect(r.value.tasks.map((t) => t.id)).toEqual(['collect', 'analyse', 'apply']);
		const applyTask = r.value.tasks[2];
		expect(applyTask).toMatchObject({
			kind: 'actions',
			allowedActions: ['frontmatter.patch'],
			allowedKeys: ['priority', 'kontext', 'projekt', 'period'],
		});
		// Weiche Felder ja, harte Felder (status/type) NIE (Brief-Vorgabe).
		if (applyTask?.kind === 'actions') {
			expect(applyTask.allowedKeys).not.toContain('status');
			expect(applyTask.allowedKeys).not.toContain('type');
		}
	});

	it('daily-briefing.md parst über parseTeamDef unter den Plugin-Default-Maxima', () => {
		const { fm } = splitFrontmatter(DAILY_BRIEFING_TEAM);
		const r = parseTeamDef('_crews/teams/daily-briefing.md', fm, {
			knownAgents: KNOWN_AGENTS,
			maxima: DEFAULT_MAXIMA,
			denylist: DENYLIST,
		});
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(r.value.id).toBe('daily-briefing');
		expect(r.value.tasks.map((t) => t.id)).toEqual(['collect', 'briefing', 'apply']);
		const llmTask = r.value.tasks[1];
		expect(llmTask).toMatchObject({ kind: 'llm', agent: 'briefing-autor', outputSchema: 'briefing-v1' });
		const applyTask = r.value.tasks[2];
		expect(applyTask).toMatchObject({ kind: 'actions', allowedActions: ['section.replace'] });
		if (applyTask?.kind === 'actions') {
			// {{today}} ist unexpandiert im geparsten Team — Expansion passiert erst zur
			// Laufzeit im Orchestrator (paths.expandTarget), nie beim Parsen.
			expect(applyTask.target).toBe('30_Chronos/10_Tage/{{today}}.md');
		}
	});
});

describe('assets/examples/** ist byte-identisch zu den TS-Konstanten', () => {
	it.each([
		['assets/examples/agents/triage-analyst.md', TRIAGE_ANALYST_AGENT],
		['assets/examples/agents/briefing-autor.md', BRIEFING_AUTOR_AGENT],
		['assets/examples/teams/task-triage.md', TASK_TRIAGE_TEAM],
		['assets/examples/teams/daily-briefing.md', DAILY_BRIEFING_TEAM],
		['assets/examples/runs.base', RUNS_BASE],
	])('%s === TS-Konstante', (relPath, constant) => {
		const onDisk = readFileSync(join(REPO_ROOT, relPath), 'utf8');
		expect(onDisk).toBe(constant);
	});
});
