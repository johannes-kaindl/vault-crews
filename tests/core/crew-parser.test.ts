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
			maxTokens: 2048, thinking: 'auto', systemPrompt: 'Du bist nüchtern.',
		});
		// Keine Temperatur im Frontmatter: es gibt keinen Persona-Wert, der das Profil überstimmt.
		expect('temperature' in r.value).toBe(false);
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

	it('nimmt trigger: interval mit gültigem Intervall an', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ trigger: 'interval', interval: '2h' }), OPTS);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.trigger).toBe('interval');
		expect(r.value.intervalMinutes).toBe(120);
	});

	it('trigger: interval braucht ein gültiges interval', () => {
		for (const interval of [undefined, '1m', 'oft', 30]) {
			const r = parseTeamDef(TEAM_PATH, teamFm({ trigger: 'interval', interval }), OPTS);
			expect(r.ok).toBe(false);
			if (r.ok) continue;
			expect(r.errors.some((e) => e.includes('interval'))).toBe(true);
		}
	});

	it('manual trägt kein Intervall', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm(), OPTS);
		expect(r.ok && r.value.intervalMinutes).toBeFalsy();
	});

	// Welle 25 (Sicherheit): ein write_scope, dessen Wurzel auf der Platte im geschützten Ordner landet, ist ein Definitionsfehler,
	// auch in der Schreibweise, die das Dateisystem auf ihn abbildet.
	it.each(['_crews /**', '_crews./teams/*.md', '_crews:s/**', '_CREWS/**', '_vaultrag /**'])(
		'lehnt write_scope %s als geschützten Bereich ab',
		(scope) => {
			const r = parseTeamDef(TEAM_PATH, teamFm({ write_scope: [scope] }), OPTS);
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.errors.join('\n')).toContain('geschützten Bereich');
		},
	);

	// Ein `..` im write_scope ist ein Definitionsfehler mit eigener Meldung: bisher fing die Denylist ihn nur zufällig ab
	// (über die Dot-Muster, mit der Meldung „geschützter Bereich“), und `a/ .. /b/**` kam durch.
	it.each(['../x/**', 'a/../b/**', 'a/ .. /b/**', '..', '**/../x', 'a\\..\\b/**'])(
		'lehnt write_scope %s wegen ".." mit eigener Meldung ab',
		(scope) => {
			const r = parseTeamDef(TEAM_PATH, teamFm({ write_scope: [scope] }), OPTS);
			expect(r.ok).toBe(false);
			if (r.ok) return;
			const text = r.errors.join('\n');
			expect(text).toContain('".." ist in write_scope nicht erlaubt');
			expect(text).not.toContain('geschützten Bereich');
		},
	);

	// Der write_scope wird beim Einlesen normalisiert gespeichert (Kit `rel-path`, wie `normalizeVaultPath` den Pfad der Aktion): `.`- und
	// leere Segmente fallen weg, `\` trennt wie `/`, ein führendes `/` heißt Vault-Wurzel. Sonst trifft der gespeicherte Rohglob nie.
	it.each([
		['./a/**', 'a/**'],
		['a/./b/**', 'a/b/**'],
		['a\\b/**', 'a/b/**'],
		['a//b/**', 'a/b/**'],
		['  ./a/**  ', 'a/**'],
	])('speichert write_scope %j normalisiert als %j', (scope, erwartet) => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ write_scope: [scope] }), OPTS);
		expect(r.ok, scope).toBe(true);
		if (!r.ok) return;
		expect(r.value.writeScope).toEqual([erwartet]);
	});

	// Eine Normalisierung gibt einem Eintrag nie mehr Schreibrecht, als er mit seinem Wortlaut hatte, wenn der Eintrag ein Ordner-Ende trägt:
	// `a/`, `a/**/` und `a/.` trafen bisher keinen Pfad (Pfade enden nie auf `/`), normalisiert wären sie `a` beziehungsweise `a/**` und träfen.
	// Sie sind Definitionsfehler mit eigener Meldung, nicht still wirksam.
	it.each(['a/', 'a/**/', 'a/.', 'a/ . ', 'a\\', 'a/**/ '])('lehnt write_scope %j mit abschließendem Trenner oder Punkt-Segment ab', (scope) => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ write_scope: [scope] }), OPTS);
		expect(r.ok, scope).toBe(false);
		if (r.ok) return;
		const text = r.errors.join('\n');
		expect(text).toContain('abschließend');
		expect(text).not.toContain('geschützten Bereich');
	});

	// Ein führender Schrägstrich ist ein absoluter Pfad, `write_scope` ist vault-relativ: eine andere Absicht als `abs/**`. Still umgedeutet
	// gäbe er Schreibrecht an einer Stelle, die der Autor nicht meinte; Definitionsfehler mit eigener Meldung (`\` am Anfang ebenso).
	it.each(['/abs/**', '//abs/**', '\\abs/**', '/a/b/*.md', ' /abs/**'])('lehnt write_scope %j als absoluten Pfad ab', (scope) => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ write_scope: [scope] }), OPTS);
		expect(r.ok, scope).toBe(false);
		if (r.ok) return;
		const text = r.errors.join('\n');
		expect(text).toContain('absoluter Pfad, write_scope ist vault-relativ');
		expect(text).not.toContain('geschützten Bereich');
	});

	// Der Schutz der Denylist ist unverändert: sie sah alle Schreibweisen schon vor der Normalisierung gleich (`isDenied` liest selbst
	// die Dateisystem-Lesart); diese Fälle halten das fest, falls jemand die Reihenfolge ändert.
	it.each([
		'_crews/./x/**', '/_crews/**', '\\_crews\\x/**', '_crews//x/**', '//_crews/**', '.\\_crews/**',
		'/.obsidian/**', '/_vaultrag/**', './.obsidian/**', '_crews/',
	])('lehnt write_scope %s weiter als geschützten Bereich ab', (scope) => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ write_scope: [scope] }), OPTS);
		expect(r.ok, scope).toBe(false);
		if (r.ok) return;
		expect(r.errors.join('\n')).toContain('geschützten Bereich');
	});

	it('lehnt ein NUL-Byte im write_scope mit eigener Meldung ab', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ write_scope: ['a\0b/**'] }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		const text = r.errors.join('\n');
		expect(text).toContain('NUL-Byte');
		expect(text).not.toContain('geschützten Bereich');
		expect(text).not.toContain('\0');
	});

	// Ein Eintrag, der zur Vault-Wurzel würde, ist ein Definitionsfehler: ein leerer Pfad als Schreibgrenze meinte den ganzen Vault.
	// `.` und `./` kamen bisher als „geschützter Bereich“ zurück, `/` wurde angenommen und roh als "/" gespeichert (traf nie).
	it.each(['.', './', '/', '\\', ' . / '])('lehnt write_scope %j als ungültigen Eintrag ab', (scope) => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ write_scope: [scope] }), OPTS);
		expect(r.ok, scope).toBe(false);
		if (r.ok) return;
		const text = r.errors.join('\n');
		expect(text).toContain('ungültiger Eintrag');
		expect(text).not.toContain('geschützten Bereich');
	});

	it('Gegenprobe: ein ähnlicher, erlaubter write_scope bleibt gültig', () => {
		for (const scope of ['Projekte /**', '_crewsX/**', '10_Aufgaben/**/*.md', 'a/b..c/**']) {
			const r = parseTeamDef(TEAM_PATH, teamFm({ write_scope: [scope] }), OPTS);
			expect(r.ok, scope).toBe(true);
			// unverändert gespeichert: auch der Leerraum im Segment (`Projekte /**` ist ein anderer Ordner als `Projekte/**`)
			if (r.ok) expect(r.value.writeScope).toEqual([scope]);
		}
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
		expect((r.value.tasks[0] as { output: unknown }).output).toEqual({ family: 'section.write', maxChars: 16_000, wording: 'neutral' });
	});

	it('briefing-v1 als Alias bleibt beim Briefing-Wortlaut', () => {
		const tasks = [
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output_schema: 'briefing-v1' },
			{ id: 'ap', kind: 'actions', inputs: ['l'], allowed_actions: ['section.replace'], target: 'a.md' },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect((r.value.tasks[0] as { output: unknown }).output).toEqual({ family: 'section.write', maxChars: 16_000, wording: 'briefing' });
	});

	describe('text.append', () => {
		const llm = (output: unknown) => ({ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output });
		const parse = (output: unknown) => parseTeamDef(TEAM_PATH, teamFm({ tasks: [llm(output)] }), OPTS);

		it('Standard max_chars 4000, keine Überschrift', () => {
			const r = parse({ family: 'text.append' });
			expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
			if (!r.ok) return;
			expect((r.value.tasks[0] as { output: unknown }).output).toEqual({ family: 'text.append', maxChars: 4000, heading: null });
		});

		it('übernimmt max_chars bis 16000 und heading', () => {
			const r = parse({ family: 'text.append', max_chars: 16_000, heading: ' Verlauf ' });
			expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
			if (!r.ok) return;
			expect((r.value.tasks[0] as { output: unknown }).output).toEqual({ family: 'text.append', maxChars: 16_000, heading: 'Verlauf' });
		});

		it.each([[16_001], [0], [-5], [1.5], ['4000']])('lehnt max_chars %s ab', (v) => {
			const r = parse({ family: 'text.append', max_chars: v });
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.join('\n')).toMatch(/max_chars/);
		});

		it.each([[''], ['  '], ['a\nb'], [5]])('lehnt heading %j ab', (v) => {
			const r = parse({ family: 'text.append', heading: v });
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.join('\n')).toMatch(/heading/);
		});

		it.each([['# Log'], ['## Log'], ['#Log']])('lehnt heading %j mit führendem # ab und nennt „ohne #“', (v) => {
			const r = parse({ family: 'text.append', heading: v });
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.join('\n')).toMatch(/heading.*ohne #/);
		});

		it('lehnt allowed_keys ab', () => {
			const r = parse({ family: 'text.append', allowed_keys: ['a'] });
			expect(r.ok).toBe(false);
		});
	});

	describe('{{input}} als Ziel', () => {
		const sw = { family: 'section.write' };
		const tasksOf = (llmExtra: Record<string, unknown>, target = '{{input}}') => [
			{ id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: ['a.md'] } },
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'x', output: sw, ...llmExtra },
			{ id: 'ap', kind: 'actions', inputs: ['l'], allowed_actions: ['section.replace'], target },
		];

		it('mit per_note: true am Modellschritt gültig', () => {
			const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: tasksOf({ per_note: true }) }), OPTS);
			expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
			if (!r.ok) return;
			expect(r.value.tasks[2]).toMatchObject({ kind: 'actions', target: '{{input}}' });
		});

		it('auch als Teil eines Pfads gültig', () => {
			const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: tasksOf({ per_note: true }, 'Log/{{input}}') }), OPTS);
			expect(r.ok).toBe(true);
		});

		it.each([[{}], [{ per_note: false }]])('ohne per_note am Modellschritt (%j) ein Fehler', (extra) => {
			const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: tasksOf(extra) }), OPTS);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.join('\n')).toContain('{{input}} verlangt per_note: true am Modellschritt');
		});

		it('prüft ALLE Modellschritte der Eingaben, nicht nur den ersten', () => {
			const tasks = [
				{ id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: ['a.md'] } },
				{ id: 'l1', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'x', output: sw, per_note: true },
				{ id: 'l2', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'x', output: sw },
				{ id: 'ap', kind: 'actions', inputs: ['l1', 'l2'], allowed_actions: ['section.replace'], target: '{{input}}' },
			];
			const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.join('\n')).toContain('{{input}} verlangt per_note: true am Modellschritt');
		});

		it('ohne jeden Modellschritt in den Eingaben ein Fehler', () => {
			const tasks = [
				{ id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: ['a.md'] } },
				{ id: 'ap', kind: 'actions', inputs: ['collect'], allowed_actions: ['section.replace'], target: '{{input}}' },
			];
			const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.join('\n')).toContain('{{input}} verlangt per_note: true am Modellschritt');
		});
	});

	describe('zwei Aktions-Schritte mit section.replace', () => {
		const two = (t1: string, t2: string, a2 = ['section.replace']) => [
			{ id: 'l1', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output: { family: 'section.write' } },
			{ id: 'l2', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'y', output: { family: 'section.write' } },
			{ id: 'a1', kind: 'actions', inputs: ['l1'], allowed_actions: ['section.replace'], target: t1 },
			{ id: 'a2', kind: 'actions', inputs: ['l2'], allowed_actions: a2, target: t2 },
		];

		it('gleiches target ist ein Fehler', () => {
			const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: two('Daily/{{today}}.md', 'Daily/{{today}}.md') }), OPTS);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.join('\n')).toMatch(/schon Ziel von section\.replace im Schritt 'a1'/);
		});

		it('dasselbe Ziel in anderer Schreibweise (Ordner, Groß-/Kleinschreibung, ./) ist ein Fehler', () => {
			for (const other of ['notes/x.md', './Notes/X.md', 'Notes//x.md', 'NOTES\\X.md']) {
				const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: two('Notes/X.md', other) }), OPTS);
				expect(r.ok, other).toBe(false);
				if (!r.ok) expect(r.errors.join('\n'), other).toMatch(/schon Ziel von section\.replace im Schritt 'a1'/);
			}
		});

		it('{{input}}-Anteile bleiben unverändert: zwei Schritte mit {{input}} sind ein Fehler, {{input}} gegen einen festen Namen nicht', () => {
			const withInput = (t1: string, t2: string) => [
				{ id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: ['a.md'] } },
				{ id: 'l1', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'x', output: { family: 'section.write' }, per_note: true },
				{ id: 'l2', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'y', output: { family: 'section.write' }, per_note: true },
				{ id: 'a1', kind: 'actions', inputs: ['l1'], allowed_actions: ['section.replace'], target: t1 },
				{ id: 'a2', kind: 'actions', inputs: ['l2'], allowed_actions: ['section.replace'], target: t2 },
			];
			const same = parseTeamDef(TEAM_PATH, teamFm({ tasks: withInput('{{input}}', '{{input}}') }), OPTS);
			expect(same.ok).toBe(false);
			const differ = parseTeamDef(TEAM_PATH, teamFm({ tasks: withInput('{{input}}', 'Log/{{input}}') }), OPTS);
			expect(differ.ok, JSON.stringify(!differ.ok && differ.errors)).toBe(true);
		});

		it('verschiedene targets sind gültig', () => {
			const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: two('A.md', 'B.md') }), OPTS);
			expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		});

		it('gleiches target, aber der zweite Schritt ersetzt keinen Abschnitt, ist gültig', () => {
			const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: two('A.md', 'A.md', ['note.append']) }), OPTS);
			expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		});
	});

	it('lehnt unbekannte family ab', () => {
		const tasks = [
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output: { family: 'note.append' } },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join('\n')).toMatch(/family.*frontmatter\.set\|section\.write\|text\.append/);
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

	it('lehnt allowed_keys auf section.write ab (artfremder Parameter)', () => {
		const tasks = [
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output: { family: 'section.write', allowed_keys: ['tags'] } },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join('\n')).toMatch(/allowed_keys.*frontmatter\.set|nur für frontmatter\.set/);
	});

	it('lehnt Nicht-String-Einträge in allowed_keys ab', () => {
		const tasks = [
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: [], instruction: 'x', output: { family: 'frontmatter.set', allowed_keys: ['tags', 3] } },
		];
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join('\n')).toMatch(/allowed_keys.*Nicht-String|Nicht-String-Einträge/);
	});
});

describe('per_note (ein Modellaufruf je Notiz)', () => {
	function llmTask(extra: Record<string, unknown>): Record<string, unknown>[] {
		return [
			{ id: 'collect', kind: 'collector', collector: 'tasknotes.query', params: { folder: '10_Aufgaben' } },
			{ id: 'l', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'x', output_schema: 'triage-v1', ...extra },
		];
	}

	it('Standard ist false', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: llmTask({}) }), OPTS);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tasks[1]).toMatchObject({ kind: 'llm', perNote: false });
	});

	it('per_note: true wird gelesen', () => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: llmTask({ per_note: true }) }), OPTS);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tasks[1]).toMatchObject({ kind: 'llm', perNote: true });
	});

	it.each([['ja'], [1], ['true'], [null]])('lehnt per_note: %j ab', (value) => {
		const r = parseTeamDef(TEAM_PATH, teamFm({ tasks: llmTask({ per_note: value }) }), OPTS);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join('\n')).toMatch(/per_note.*true\|false/);
	});
});
