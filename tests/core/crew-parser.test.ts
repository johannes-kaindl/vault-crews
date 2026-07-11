import { describe, expect, it } from 'vitest';
import { parseAgentDef, parseTeamDef } from '../../src/core/crew-parser';
import { buildDenylist } from '../../src/core/paths';
import type { RunLimits } from '../../src/core/types';

const MAXIMA: RunLimits = { maxWrites: 20, maxLlmCalls: 10, wallClockMs: 600_000, maxNoteBytes: 65_536, callTimeoutMs: 300_000, stallTimeoutMs: 60_000 };
const OPTS = { knownAgents: ['triage-analyst'], maxima: MAXIMA, denylist: buildDenylist('.obsidian', '_crews') };
const AGENT_PATH = '_crews/agents/triage-analyst.md';
const TEAM_PATH = '_crews/teams/task-triage.md';

function teamFm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		'crew-kind': 'team',
		name: 'Task-Triage',
		version: 1,
		description: 'Prüft Backlog.',
		trigger: 'manual',
		limits: { max_writes: 15 },
		write_scope: ['10_Aufgaben/**/*.md'],
		tasks: [
			{ id: 'collect', kind: 'collector', collector: 'tasknotes.query', params: { folder: '10_Aufgaben' } },
			{ id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Bewerte.', output_schema: 'triage-v1' },
			{ id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['priority'] },
		],
		...overrides,
	};
}

describe('parseAgentDef', () => {
	it('parst gültigen Agenten mit Defaults', () => {
		const r = parseAgentDef(AGENT_PATH, { 'crew-kind': 'agent', name: 'Triage-Analyst' }, '  Du bist nüchtern.  ');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value).toEqual({
			id: 'triage-analyst', name: 'Triage-Analyst', model: null,
			temperature: 0.1, maxTokens: 2048, thinking: 'auto', systemPrompt: 'Du bist nüchtern.',
		});
	});

	it('meldet fehlenden name, leeren Body und falschen kind einzeln', () => {
		const r = parseAgentDef(AGENT_PATH, { 'crew-kind': 'nope' }, '');
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.some((e) => e.includes('crew-kind'))).toBe(true);
		expect(r.errors.some((e) => e.includes('name'))).toBe(true);
		expect(r.errors.some((e) => e.includes('systemPrompt') || e.includes('Body'))).toBe(true);
		expect(r.errors.every((e) => e.startsWith(AGENT_PATH))).toBe(true);
	});

	it('meldet fehlendes Frontmatter', () => {
		const r = parseAgentDef(AGENT_PATH, null, 'x');
		expect(r.ok).toBe(false);
	});
});

describe('parseTeamDef', () => {
	it('parst gültiges Team (snake_case → camelCase, Limit-Deckelung greift nicht)', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm(), OPTS);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(r.value.id).toBe('task-triage');
		expect(r.value.maxWrites).toBe(15);
		expect(r.value.writeScope).toEqual(['10_Aufgaben/**/*.md']);
		expect(r.value.tasks[1]).toMatchObject({ kind: 'llm', output: { family: 'frontmatter.set', allowedKeys: '*' }, onError: 'abort' });
		expect(r.value.tasks[2]).toMatchObject({ kind: 'actions', allowedKeys: ['priority'], target: null });
		expect(r.value.sourcePath).toBe(TEAM_PATH);
	});

	it('parst create_if_missing: true auf actions-Task', () => {
		const tasks = [
			{ id: 'collect', kind: 'collector', collector: 'tasknotes.query', params: { folder: '10_Aufgaben' } },
			{ id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'B.', output_schema: 'triage-v1' },
			{ id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['section.replace'], target: 'Daily/{{today}}.md', create_if_missing: true },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(r.value.tasks[2]).toMatchObject({ kind: 'actions', createIfMissing: true });
	});

	it('create_if_missing fehlt → Default false', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm(), OPTS);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tasks[2]).toMatchObject({ kind: 'actions', createIfMissing: false });
	});

	it('create_if_missing nicht-boolean → Fehler', () => {
		const tasks = [
			{ id: 'collect', kind: 'collector', collector: 'tasknotes.query', params: { folder: '10_Aufgaben' } },
			{ id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'B.', output_schema: 'triage-v1' },
			{ id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['section.replace'], target: 'Daily/{{today}}.md', create_if_missing: 'yes' },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.some((e) => e.includes('create_if_missing'))).toBe(true);
	});

	it('deckelt max_writes auf das Plugin-Maximum', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ limits: { max_writes: 999 } }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.some((e) => e.includes('max_writes'))).toBe(true);
	});

	it('sammelt ALLE Fehler statt first-fail', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm({
			version: 2,
			trigger: 'schedule',
			write_scope: ['_crews/**'],
			tasks: [
				{ id: 'a', kind: 'llm', agent: 'unbekannt', inputs: ['später'], instruction: 'x', output_schema: 'nope' },
				{ id: 'a', kind: 'collector', collector: 'tasknotes.query', params: {} },
				{ id: 'später', kind: 'actions', inputs: ['a'], allowed_actions: ['delete.everything'] },
			],
		}), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		const all = r.errors.join('\n');
		expect(all).toContain('version');
		expect(all).toContain('trigger');
		expect(all).toContain('write_scope');
		expect(all).toContain('agent');
		expect(all).toContain('inputs');
		expect(all).toContain('output_schema');
		expect(all).toContain('allowed_actions');
		expect(all).toMatch(/id.*doppelt|doppelt.*id|eindeutig/i);
		expect(r.errors.every((e) => e.startsWith(TEAM_PATH))).toBe(true);
	});

	it('lehnt Vorwärts- und Selbst-Referenzen in inputs ab', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm({
			tasks: [
				{ id: 'x', kind: 'llm', agent: 'triage-analyst', inputs: ['x'], instruction: 'i', output_schema: 'triage-v1' },
			],
		}), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.some((e) => e.includes('inputs'))).toBe(true);
	});

	it('lehnt leere tasks und fehlendes Frontmatter ab', () => {
		expect(parseTeamDef(TEAM_PATH, teamFm({ tasks: [] }), OPTS).ok).toBe(false);
		expect(parseTeamDef(TEAM_PATH, null, OPTS).ok).toBe(false);
	});
});

describe('output: block (schema families)', () => {
	// Nutzt die Bestandshelfer dieser Datei: teamFm(overrides) baut ein vollständiges
	// Team-Frontmatter, `tasks` wird pro Fall überschrieben; parseTeamDef(TEAM_PATH, fm, OPTS)
	// ist der reale Parsing-Entry-Point. OPTS kennt den Agenten 'triage-analyst'.

	it('parst frontmatter.set mit allowed_keys', () => {
		const tasks = [
			{ id: 'collect', kind: 'collector', collector: 'vault.list', params: {} },
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'x', output: { family: 'frontmatter.set', allowed_keys: ['tags', 'kategorie'] } },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect((r.value.tasks[1] as { output: unknown }).output).toEqual({ family: 'frontmatter.set', allowedKeys: ['tags', 'kategorie'] });
	});

	it('parst section.write mit Default max_chars', () => {
		const tasks = [
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output: { family: 'section.write' } },
			{ id: 'ap', kind: 'actions', inputs: ['l'], allowed_actions: ['section.replace'], target: '30_Chronos/heute.md' },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect((r.value.tasks[0] as { output: unknown }).output).toEqual({ family: 'section.write', maxChars: 16_000 });
	});

	it('lehnt unbekannte family ab', () => {
		const tasks = [
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output: { family: 'note.append' } },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join('\n')).toMatch(/family.*frontmatter\.set\|section\.write/);
	});

	it('lehnt frontmatter.set ohne allowed_keys ab', () => {
		const tasks = [
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output: { family: 'frontmatter.set' } },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join('\n')).toMatch(/allowed_keys/);
	});

	it('lehnt output und output_schema gleichzeitig ab', () => {
		const tasks = [
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output_schema: 'triage-v1', output: { family: 'frontmatter.set', allowed_keys: ['tags'] } },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join('\n')).toMatch(/output.*output_schema|nicht beide/);
	});

	it('lehnt Task ohne output und ohne output_schema ab', () => {
		const tasks = [
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x' },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok).toBe(false);
	});
});
