/** Deterministischer Prompt-Aufbau (Spec §3.3): jeder llm-Call ist frisch, in sich
 *  vollständig und byte-reproduzierbar (Prompt-Hash als Beweis). Kein Gesprächsverlauf.
 *  Budget-Grundsatz: lieber vor dem Call scheitern oder markiert kürzen als still überlaufen. */
import { fnv1a } from './collectors';
import { contextOverflow, estimateTokens } from '../vendor/kit/model-context';
import { LlmCallError } from './ports';
import type { LlmMessage } from './ports';
import type { SchemaDef } from './schemas';
import type { AgentDef, Artifact, LlmTaskDef, SlugTableData } from './types';

export interface BuiltPrompt { messages: LlmMessage[]; promptHash: string; truncated: boolean; }

/** Passt eine Anfrage aus `chars` Zeichen ins Budget? Das Kit schätzt die Zeichen ALLER gesendeten Nachrichten einmal (`cautious`, 3,5 Zeichen je Token:
 *  ein Budget, das kürzt, darf nicht zu klein schätzen) und rundet am Ende; vor Kit 0.69.0 rundeten `system` und `user` getrennt (bis zu ein Token mehr). */
function fits(chars: number, budgetTokens: number): boolean {
	// Ein Limit <= 0 ist im Kit „unbekannt“ und passt immer; ein Budget von 0 ist hier aber „nichts passt“ (der Orchestrator reicht mindestens 1).
	return budgetTokens > 0 && contextOverflow(estimateTokens(chars, 'cautious'), budgetTokens) === null;
}

export function buildPrompt(
	agent: AgentDef,
	task: LlmTaskDef,
	inputs: Artifact[],
	schema: SchemaDef,
	budgetTokens: number,
	/** Wertemengen aus dem Bestand (`values`): sie stehen vor denen der Eingaben, und ein Schlüssel von hier verdrängt den gleichen Schlüssel dort. */
	extraTables?: Record<string, SlugTableData>,
): BuiltPrompt {
	const system = buildSystem(agent, inputs, schema, extraTables);
	const fixedUser = task.instruction;
	const fixedChars = system.length + fixedUser.length;
	if (!fits(fixedChars, budgetTokens)) {
		throw new LlmCallError(
			`Instruktion + Output-Vertrag (${estimateTokens(fixedChars, 'cautious')} tokens) überschreiten das Budget (${budgetTokens})`,
			'overflow',
		);
	}

	// Blockweise Kürzung von hinten: ganze Datei-Einträge entfernen, bis das Budget passt.
	const counts = inputs.map((a) => a.files.length);
	let truncated = false;
	for (;;) {
		const user = buildUser(task, inputs, counts);
		// `user` trägt die Instruktion schon: gezählt wird `system` + `user`, die Instruktion nicht doppelt.
		if (fits(system.length + user.length, budgetTokens)) {
			const messages: LlmMessage[] = [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			];
			return { messages, promptHash: fnv1a(messages.map((m) => `${m.role}\n${m.content}`).join('\n\u0000')), truncated };
		}
		const idx = lastNonEmpty(counts);
		if (idx < 0) {
			throw new LlmCallError(`Kontext passt auch leer nicht ins Budget (${budgetTokens})`, 'overflow');
		}
		counts[idx] = (counts[idx] ?? 1) - 1;
		truncated = true;
	}
}

function buildSystem(agent: AgentDef, inputs: Artifact[], schema: SchemaDef, extraTables?: Record<string, SlugTableData>): string {
	const parts = [agent.systemPrompt, schema.promptContract];
	const seen = new Set<string>();
	const addTables = (tables: Record<string, SlugTableData>): void => {
		for (const [key, table] of Object.entries(tables)) {
			if (seen.has(key)) continue;
			seen.add(key);
			const slugs = Object.keys(table.fromSlug).sort();
			if (slugs.length > 0) parts.push(`Erlaubte Werte für ${key}: ${slugs.join(', ')}`);
		}
	};
	if (extraTables !== undefined) addTables(extraTables);
	for (const a of inputs) addTables(a.slugTables);
	// 'text'-Schemata (briefing-v1) dürfen das Beispiel NICHT in einem ```json-Fence sehen —
	// sonst ahmt das Modell den Fence in seiner Antwort nach (genau der Bug, den outputFormat
	// vermeiden soll). 'json'-Schemata bekommen den Fence weiterhin, das schärft das Format ein.
	parts.push(
		schema.outputFormat === 'json'
			? `Beispiel der erwarteten Antwort:\n\`\`\`json\n${schema.outputExample}\n\`\`\``
			: `Beispiel:\n${schema.outputExample}`,
	);
	return parts.join('\n\n');
}

function buildUser(task: LlmTaskDef, inputs: Artifact[], counts: number[]): string {
	const parts = [task.instruction];
	for (let i = 0; i < inputs.length; i++) {
		const a = inputs[i];
		if (!a) continue;
		const total = a.files.length;
		const kept = Math.max(0, counts[i] ?? total);
		const files = a.files.slice(0, kept);
		const header = `=== KONTEXT: ${a.taskId} (${total} Dateien) ===`;
		const marker = kept < total ? `\n[gekürzt: ${kept} von ${total} Einträgen enthalten]` : '';
		parts.push(`${header}\n${JSON.stringify({ ...asRecord(a.json), files }, jsonStable)}${marker}`);
	}
	return parts.join('\n\n');
}

function lastNonEmpty(counts: number[]): number {
	for (let i = counts.length - 1; i >= 0; i--) {
		if ((counts[i] ?? 0) > 0) return i;
	}
	return -1;
}

function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
}

/** Stabile Serialisierung: content-Felder bleiben, undefined fällt weg — kein Zufall im Prompt. */
function jsonStable(_key: string, value: unknown): unknown {
	return value === undefined ? null : value;
}
