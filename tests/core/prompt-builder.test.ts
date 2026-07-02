import { describe, expect, it } from 'vitest';
import { buildPrompt, estimateTokens } from '../../src/core/prompt-builder';
import { LlmCallError } from '../../src/core/ports';
import type { SchemaDef } from '../../src/core/schemas';
import type { AgentDef, Artifact, LlmTaskDef } from '../../src/core/types';

const AGENT: AgentDef = {
	id: 'triage-analyst', name: 'Triage-Analyst', model: null,
	temperature: 0.1, maxTokens: 512, thinking: 'auto',
	systemPrompt: 'Du bist ein nüchterner Analyst.',
};
const TASK: LlmTaskDef = {
	id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'],
	instruction: 'Bewerte jede Aufgabe.', outputSchema: 'triage-v1', onError: 'abort',
};
const SCHEMA: Pick<SchemaDef, 'id' | 'jsonExample'> = {
	id: 'triage-v1',
	jsonExample: '{"items": [{"path": "10_A/t.md", "set": {"priority": "mittel"}}]}',
};

function artifact(n: number): Artifact {
	const files = Array.from({ length: n }, (_, i) => ({
		path: `10_A/t${i}.md`, contentHash: `h${i}`,
		frontmatter: { title: `Task ${i}`, status: 'backlog' }, content: null,
	}));
	return {
		taskId: 'collect', json: { files }, files,
		slugTables: { status: { toSlug: { '1_backlog_📥': 'backlog' }, fromSlug: { backlog: '1_backlog_📥' } } },
	};
}

describe('estimateTokens', () => {
	it('rechnet ceil(chars/3.5)', () => {
		expect(estimateTokens('1234567')).toBe(2);
		expect(estimateTokens('')).toBe(0);
	});
});

describe('buildPrompt', () => {
	it('schichtet System (Prompt+Vertrag+Wertemengen+One-Shot) und User (Instruktion+Kontext)', () => {
		const p = buildPrompt(AGENT, TASK, [artifact(2)], SCHEMA as SchemaDef, 4000);
		const sys = p.messages[0];
		const usr = p.messages[1];
		expect(sys?.role).toBe('system');
		expect(sys?.content).toContain('Du bist ein nüchterner Analyst.');
		expect(sys?.content).toContain('```json-Block');
		expect(sys?.content).toContain('Erlaubte Werte für status: backlog');
		expect(sys?.content).toContain(SCHEMA.jsonExample);
		expect(usr?.role).toBe('user');
		expect(usr?.content).toContain('Bewerte jede Aufgabe.');
		expect(usr?.content).toContain('=== KONTEXT: collect (2 Dateien) ===');
		expect(usr?.content).toContain('10_A/t1.md');
		expect(p.truncated).toBe(false);
	});

	it('ist byte-deterministisch (gleicher Hash bei gleichen Inputs)', () => {
		const a = buildPrompt(AGENT, TASK, [artifact(3)], SCHEMA as SchemaDef, 4000);
		const b = buildPrompt(AGENT, TASK, [artifact(3)], SCHEMA as SchemaDef, 4000);
		expect(a.promptHash).toBe(b.promptHash);
		expect(a.messages).toEqual(b.messages);
	});

	it('kürzt blockweise von hinten mit Marker, wenn das Budget nicht reicht', () => {
		const full = buildPrompt(AGENT, TASK, [artifact(30)], SCHEMA as SchemaDef, 100_000);
		const tight = buildPrompt(AGENT, TASK, [artifact(30)], SCHEMA as SchemaDef, estimateTokens(full.messages.map((m) => m.content).join('')) - 200);
		expect(tight.truncated).toBe(true);
		expect(tight.messages[1]?.content).toMatch(/\[gekürzt: \d+ von 30 Einträgen enthalten\]/);
		expect(tight.messages[1]?.content).not.toContain('t29.md');
	});

	it('wirft LlmCallError(overflow), wenn Instruktion+Vertrag allein das Budget sprengen', () => {
		expect(() => buildPrompt(AGENT, TASK, [artifact(1)], SCHEMA as SchemaDef, 10)).toThrow(LlmCallError);
	});
});
