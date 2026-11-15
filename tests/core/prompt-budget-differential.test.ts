import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/core/prompt-builder';
import { estimateTokens } from '../../src/vendor/kit/model-context';
import type { SchemaDef } from '../../src/core/schemas';
import type { AgentDef, Artifact, LlmTaskDef } from '../../src/core/types';

const AGENT: AgentDef = {
	id: 'a', name: 'A', model: null, temperature: 0.1, maxTokens: 512, thinking: 'auto',
	systemPrompt: 'Du bist ein nüchterner Analyst. Prüfe Umlaute (äöüß), Emoji 📥 und lange Wörter wie Donaudampfschifffahrtsgesellschaft.',
};
const TASK: LlmTaskDef = {
	id: 'analyse', kind: 'llm', agent: 'a', inputs: ['collect'], instruction: 'Bewerte jede Aufgabe.',
	output: { family: 'frontmatter.set', allowedKeys: '*', values: {}, addTo: [] }, onError: 'abort', perNote: false,
};
const JSON_SCHEMA = {
	id: 'triage-v1', outputFormat: 'json',
	promptContract: 'Antworte ausschließlich mit einem JSON-Objekt in einem ```json-Block, keine Erklärungen davor oder danach.',
	outputExample: '{"items": [{"path": "10_A/t.md", "set": {"priority": "mittel"}}]}',
} as SchemaDef;
const TEXT_SCHEMA = {
	id: 'briefing-v1', outputFormat: 'text',
	promptContract: 'Antworte ausschließlich mit dem fertigen Briefing als Markdown-Text.', outputExample: '## Heute fällig\n- Beispiel',
} as SchemaDef;

function artifact(n: number): Artifact {
	const files = Array.from({ length: n }, (_, i) => ({
		path: `10_Projekte/Umlaute/Übersicht ${i}.md`, contentHash: `h${i}`,
		frontmatter: { title: `Aufgabe ${i} — größere Änderung`, status: 'backlog', tags: ['a', 'b'] }, content: i % 3 === 0 ? 'Fließtext '.repeat(i + 1) : null,
	}));
	return { taskId: 'collect', json: { files }, files, slugTables: { status: { toSlug: { '1_backlog_📥': 'backlog' }, fromSlug: { backlog: '1_backlog_📥' } } } };
}

/** Die Rechnung vor Kit 0.69.0 (`src/core/prompt-builder.ts`): zwei getrennte Rundungen. */
const oldTokens = (system: string, user: string): number => Math.ceil(system.length / 3.5) + Math.ceil(user.length / 3.5);
/** Die Rechnung jetzt: die Summe der Zeichen einmal. */
const newTokens = (system: string, user: string): number => estimateTokens(system.length + user.length, 'cautious');

/** Ein fester Satz echter Prompts: dieselbe Eingabe mit Budgets von 150 bis 2000 in Schritten von 7 (dazwischen kürzt der Bauer unterschiedlich weit), je Schema. */
function promptSet(): Array<{ system: string; user: string }> {
	const out: Array<{ system: string; user: string }> = [];
	for (const schema of [JSON_SCHEMA, TEXT_SCHEMA]) {
		for (let budget = 150; budget <= 2000; budget += 7) {
			try {
				const p = buildPrompt(AGENT, TASK, [artifact(30)], schema, budget);
				out.push({ system: p.messages[0]?.content ?? '', user: p.messages[1]?.content ?? '' });
			} catch { /* zu klein für den festen Teil */ }
		}
	}
	return out;
}

/** Wie viele Einträge (von 30) hat dieser Prompt behalten? Der Marker steht nur im gekürzten Fall. */
function keptOf(user: string): number {
	const m = /\[gekürzt: (\d+) von 30 Einträgen enthalten\]/.exec(user);
	return m ? Number(m[1]) : 30;
}

describe('Token-Schätzung des Prompt-Bauers: alt (zwei Rundungen) gegen neu (Kit, eine Rundung)', () => {
	const set = promptSet();
	const diffs = set.map((p) => oldTokens(p.system, p.user) - newTokens(p.system, p.user));

	it('Schätzung: die Summe einmal gerundet ist nie größer als die zwei Rundungen, und um höchstens ein Token kleiner', () => {
		// Gemessen am festen Satz (Eingabe und Budgets stehen oben): 530 Prompts, davon 492 mit Unterschied 1, keiner mit mehr, keiner mit negativem.
		// Der hohe Anteil kommt vom Satz: `system` ist je Schema konstant, nur `user` wandert; im Mittel über beliebige Längen sind es rund die Hälfte.
		expect(set.length).toBe(530);
		expect(diffs.filter((d) => d !== 0).length).toBe(492);
		expect(Math.max(...diffs)).toBe(1);
		expect(Math.min(...diffs)).toBe(0);
	});

	it('Kürzung: der Bauer behält bei jedem Budget so viel wie die Kit-Rechnung ergibt, höchstens einen Eintrag mehr als die alte, nie weniger', () => {
		const schema = JSON_SCHEMA;
		const system = buildPrompt(AGENT, TASK, [artifact(30)], schema, 1_000_000).messages[0]?.content ?? '';
		// Alle Stufen der Kürzung als `user`-Texte, einmal gesammelt: das Budget wandert von klein nach groß, jede neue Stufe taucht auf.
		const userByKept = new Map<number, string>();
		for (let b = 1; b <= 6000; b++) {
			try {
				const u = buildPrompt(AGENT, TASK, [artifact(30)], schema, b).messages[1]?.content ?? '';
				userByKept.set(keptOf(u), u);
			} catch { /* festes Gerüst passt noch nicht */ }
		}
		const keptByRule = (budget: number, tokens: (s: string, u: string) => number): number => {
			for (let k = 30; k >= 0; k--) {
				const u = userByKept.get(k);
				if (u !== undefined && tokens(system, u) <= budget) return k;
			}
			return -1;
		};
		let differ = 0, maxMore = 0, checked = 0;
		for (let b = 1; b <= 6000; b++) {
			let actual: number;
			try { actual = keptOf(buildPrompt(AGENT, TASK, [artifact(30)], schema, b).messages[1]?.content ?? ''); } catch { continue; }
			checked += 1;
			expect(actual).toBe(keptByRule(b, newTokens));   // der Bauer rechnet wie das Kit, Budget für Budget
			const old = keptByRule(b, oldTokens);
			if (old !== actual) differ += 1;
			maxMore = Math.max(maxMore, actual - old);
			expect(actual).toBeGreaterThanOrEqual(old);       // nie weniger als vorher
		}
		// Gemessen: 5861 Budgets mit lauffähigem Gerüst (139 bis 6000), 31 Kürzungsstufen (0 bis 30 Einträge). Bei 27 Budgets (0,46 %) behält der Bauer einen Eintrag mehr, bei keinem mehr als einen.
		expect({ checked, differ, maxMore, stufen: userByKept.size }).toEqual({ checked: 5861, differ: 27, maxMore: 1, stufen: 31 });
	});
});
