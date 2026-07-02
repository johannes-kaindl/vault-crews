// tests/golden/daily-briefing.test.ts
/** Golden-Run-Test (Spec §8, "der Regressions-Anker"): treibt die volle,
 *  TATSÄCHLICH AUSGELIEFERTE Daily-Briefing-Beispiel-Crew
 *  (`src/obsidian/example-assets.ts`, byte-identisch zu `assets/examples/**`,
 *  s. `tests/obsidian/install-examples.test.ts`) end-to-end durch den echten
 *  `executeRun` — mit denselben Test-Doubles wie `tests/core/orchestrator.test.ts`
 *  (InMemoryVaultPort/FixtureMetadataPort, ScriptLlmClient, RecorderGitPort,
 *  FakeClock, RecorderReporter) — und vergleicht drei Artefakte byte-exakt gegen
 *  inline golden values: (1) die gepatchte Daily Note, (2) run.md, (3) den am
 *  RecorderGitPort aufgezeichneten CommitPlan.
 *
 *  Normalisierung (s. Report .superpowers/sdd/task-19-report.md): `{{today}}`
 *  (paths.ts:expandTarget) und der Lauf-`runId` (orchestrator.ts:formatRunId)
 *  werden beide aus LOKALEN — NICHT UTC — Date-Gettern der FakeClock abgeleitet;
 *  ein hartkodiertes Datums-/Uhrzeit-Literal wäre auf Maschinen in einer anderen
 *  Zeitzone als der Autoren-Maschine flakey. Beide Werte werden daher zur
 *  Laufzeit über denselben Produktions-Helfer (`expandTarget`) bzw. per Ist-Wert
 *  aus dem `RunResult` ermittelt und vor dem Byte-Vergleich durch stabile
 *  Platzhalter-Tokens ersetzt (`normalize()`). NUR der `{{today}}.md`-Dateiname
 *  wird so maskiert (nicht jedes Vorkommen des bloßen Datumsstrings!) — ein
 *  früherer Entwurf ersetzte den nackten `today`-String im ganzen Text und
 *  zerstörte dabei zufällig das Datum in den `started`/`ended`-Zeitstempeln,
 *  weil lokales Datum (November, Standardzeit UTC+1) und UTC-Datum hier
 *  zufällig übereinstimmen — auf einer Maschine, wo das nicht der Fall ist,
 *  wäre das golden literal falsch dagewesen. run.md-Zeitstempel (`started`/
 *  `ended`, `run-log.ts:iso()`) sind `Date#toISOString()` (immer UTC,
 *  spec-garantiert) und deshalb als LITERALER Wert hartkodiert — überall
 *  deterministisch, keine Normalisierung nötig/zulässig. `duration_s` ist 0,
 *  weil die FakeClock ohne expliziten `.tick()` nie weiterläuft und dieser
 *  Golden-Run keinen index.lock-Retry (den einzigen `delay()`-Pfad) auslöst.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// js-yaml ist reines Test-Tooling (devDependency, wie in
// tests/obsidian/install-examples.test.ts) — parst die ECHTE, verschachtelte
// YAML-Frontmatter der ausgelieferten Team-Datei (tasks/params/where).
import * as yaml from 'js-yaml';

import { executeRun, type RunDeps } from '../../src/core/orchestrator';
import { expandTarget } from '../../src/core/paths';
import type { RunLimits } from '../../src/core/types';
import { BRIEFING_AUTOR_AGENT, DAILY_BRIEFING_TEAM } from '../../src/obsidian/example-assets';
import { FakeClock } from '../helpers/fake-clock';
import { FixtureMetadataPort, InMemoryVaultPort } from '../helpers/in-memory-vault';
import { RecorderGitPort } from '../helpers/recorder-git';
import { RecorderReporter } from '../helpers/recorder-reporter';
import { ScriptLlmClient } from '../helpers/script-llm';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'tests/fixtures/pallas-tasknotes');

const START_MS = 1_700_000_000_000;

const LIMITS: RunLimits = {
	maxWrites: 10, maxLlmCalls: 2, wallClockMs: 600_000,
	maxNoteBytes: 65_536, callTimeoutMs: 300_000, stallTimeoutMs: 60_000,
};

// Realistischer, gescripteter Modell-Output (Präambel + ```json-Fence + Nachsatz)
// statt reinem JSON — nimmt denselben Extraktionspfad (letzter Fence, Spec §3.4)
// wie ein echtes Reasoning-Modell, ohne dass ein LLM live läuft.
const BRIEFING_MARKDOWN =
	'## Heute fällig\n' +
	'- Plugin-Release vorbereiten\n\n' +
	'## Überfällig\n' +
	'Keine überfälligen Aufgaben — alles im Rahmen.\n\n' +
	'## Eine nächste Handlung\n' +
	'Steuererklärung 2025 einreichen.';
const BRIEFING_LLM_OUTPUT =
	'Hier ist das Briefing:\n\n' +
	'```json\n' +
	JSON.stringify({ markdown: BRIEFING_MARKDOWN }) +
	'\n```\n';

const EXISTING_DAILY = '---\ntype: daily\n---\n# Daily Note\n\n## Journal\n\nKurzer Tagesrückblick vom Vortag.\n';

/** Frontmatter-Block + Body per echtem YAML-Parser splitten (wie install-examples.test.ts) —
 *  das kleine Flat-YAML-Subset aus in-memory-vault.ts reicht für die verschachtelte
 *  Team-Definition (tasks/params/where) nicht aus. */
function splitFrontmatter(raw: string): { fm: Record<string, unknown> | null; body: string } {
	if (!raw.startsWith('---\n')) return { fm: null, body: raw };
	const end = raw.indexOf('\n---\n', 4);
	if (end < 0) return { fm: null, body: raw };
	const block = raw.slice(4, end);
	const body = raw.slice(end + 5);
	const fm = yaml.load(block);
	return { fm: (fm ?? null) as Record<string, unknown> | null, body };
}

/** Ersetzt die beiden lokalzeit-/laufabhängigen Werte durch stabile Platzhalter,
 *  bevor byte-exakt verglichen wird (s. Normalisierungs-Kommentar oben). Der
 *  `today`-Ersatz ist bewusst auf den `.md`-Dateinamen zugeschnitten (nicht der
 *  nackte Datumsstring) — sonst kollidiert er mit dem UTC-Datum in den
 *  `started`/`ended`-ISO-Zeitstempeln. */
function normalize(text: string, runId: string, todayMdName: string): string {
	return text.split(todayMdName).join('<TODAY>.md').split(runId).join('<RUN_ID>');
}

describe('Golden-Run: ausgelieferte Daily-Briefing-Crew, end-to-end', () => {
	it('collector -> llm -> section.replace: byte-exakte Daily Note, run.md, CommitPlan', async () => {
		const vault = new InMemoryVaultPort();
		const meta = new FixtureMetadataPort(vault);

		// (c) die ausgelieferte Team- + Agent-Datei unter der Crew-Wurzel, so wie
		// installExampleCrews() sie tatsächlich in den Vault schreibt.
		const teamPath = '_crews/teams/daily-briefing.md';
		const { fm: teamFm } = splitFrontmatter(DAILY_BRIEFING_TEAM);
		await vault.create(teamPath, DAILY_BRIEFING_TEAM);
		meta.setFrontmatter(teamPath, teamFm ?? {});

		const agentPath = '_crews/agents/briefing-autor.md';
		const { fm: agentFm } = splitFrontmatter(BRIEFING_AUTOR_AGENT);
		await vault.create(agentPath, BRIEFING_AUTOR_AGENT);
		meta.setFrontmatter(agentPath, agentFm ?? {});

		// (a) echte, anonymisierte Pallas-TaskNotes-Fixtures (bereits in
		// tests/core/collectors.test.ts genutzt) unter dem Ordner, den `collect`
		// tatsächlich abfragt (10_Aufgaben, s. DAILY_BRIEFING_TEAM.tasks[0].params.folder).
		for (const f of readdirSync(FIXTURE_DIR)) {
			await vault.create(`10_Aufgaben/${f}`, readFileSync(join(FIXTURE_DIR, f), 'utf8'));
		}

		// (b) existierende Daily Note am expandierten {{today}}-Ziel
		// (create_if_missing:false verlangt Pre-Existenz, Spec §4.3).
		const clock = new FakeClock(START_MS);
		const today = expandTarget('{{today}}', clock.now());
		const todayMdName = `${today}.md`;
		const dailyPath = `30_Chronos/10_Tage/${todayMdName}`;
		await vault.create(dailyPath, EXISTING_DAILY);

		const reporter = new RecorderReporter();
		const git = new RecorderGitPort();
		const llm = new ScriptLlmClient([{ content: BRIEFING_LLM_OUTPUT }], 8192);

		const settings: RunDeps['settings'] = {
			crewRoot: '_crews',
			defaultModel: 'test-model',
			configDir: '.obsidian',
			endpoints: ['http://localhost:1234'],
			deniedEndpoints: [],
			limits: LIMITS,
		};
		const deps: RunDeps = {
			vault, meta, llm, git, clock, reporter, settings,
			abort: new AbortController().signal,
		};

		const result = await executeRun(teamPath, deps);

		// ---- Status-Sanity (Vorbedingung für die Golden-Vergleiche unten) -------
		expect(result.status).toBe('ok');
		expect(result.errorKind).toBeNull();
		expect(result.errorTask).toBeNull();
		expect(result.writes).toBe(1);
		expect(result.commitSha).toBe('sha-1');
		expect(result.runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-daily-briefing$/);
		expect(llm.calls).toHaveLength(1); // kein Repair nötig — Modell liefert gültiges briefing-v1 auf Anhieb
		// runStarted…runFinished-Rahmen, genau ein taskStarted/taskFinished-Paar pro Task.
		expect(reporter.events.filter((e) => e.type !== 'token').map((e) => e.type)).toEqual([
			'runStarted',
			'taskStarted', 'taskFinished',
			'taskStarted', 'taskFinished',
			'taskStarted', 'actionApplied', 'taskFinished',
			'runFinished',
		]);

		// ---- (1) Daily Note nach section.replace, byte-exakt --------------------
		const daily = await vault.read(dailyPath);
		expect(daily).toBe(GOLDEN_DAILY_NOTE);

		// ---- (2) run.md, byte-exakt (runId/{{today}} normalisiert) --------------
		const runDir = `_crews/runs/${result.runId}`;
		const runMdRaw = await vault.read(`${runDir}/run.md`);
		expect(normalize(runMdRaw, result.runId, todayMdName)).toBe(GOLDEN_RUN_MD);

		// state.json ist Maschinenzustand (kein Beobachtungs-/Undo-Vertrag wie
		// run.md) — hier reicht ein struktureller statt byte-exakter Check.
		const stateRaw = await vault.read(`${runDir}/state.json`);
		const state = JSON.parse(stateRaw) as { status: string; llmCalls: number; writeRegister: string[] };
		expect(state.status).toBe('ok');
		expect(state.llmCalls).toBe(1);
		expect(state.writeRegister).toEqual([dailyPath]);

		// ---- (3) CommitPlan am RecorderGitPort, byte-exakt -----------------------
		expect(git.log).toEqual(['status', 'applyPlan:sha-1']);
		const plan = git.plans[0];
		expect(plan).toBeDefined();
		if (plan === undefined) return;
		expect(normalize(plan.message, result.runId, todayMdName)).toBe(GOLDEN_COMMIT_MESSAGE);
		expect(plan.paths.map((p) => normalize(p, result.runId, todayMdName))).toEqual(GOLDEN_COMMIT_PATHS);
	});
});

// ── Inline golden values ──────────────────────────────────────────────────
// Erzeugt durch einen realen Lauf der Pipeline oben (TDD-RED-Capture, s.
// Report .superpowers/sdd/task-19-report.md) — nicht von Hand berechnet.
// `<RUN_ID>`/`<TODAY>.md` sind die normalize()-Platzhalter von oben.

const GOLDEN_DAILY_NOTE = `---
type: daily
---
# Daily Note

## Journal

Kurzer Tagesrückblick vom Vortag.

<!-- crew:daily-briefing -->
## Heute fällig
- Plugin-Release vorbereiten

## Überfällig
Keine überfälligen Aufgaben — alles im Rahmen.

## Eine nächste Handlung
Steuererklärung 2025 einreichen.
<!-- /crew:daily-briefing -->
`;

const GOLDEN_RUN_MD = `---
crew-kind: run
team: daily-briefing
started: 2023-11-14T22:13:20.000Z
ended: 2023-11-14T22:13:20.000Z
status: ok
commit: sha-1
writes: 1
llm_calls: 1
duration_s: 0
model: test-model
---

# Run <RUN_ID>

## collect

- Status: ok
- Dauer: 0.0 s

\`\`\`json
{
  "files": [
    {
      "path": "10_Aufgaben/zahnarzt.md",
      "contentHash": "85deb0f6",
      "frontmatter": {
        "title": "zahnarzt-termin-vereinbaren",
        "status": "backlog",
        "priority": null,
        "kontext": [
          "telefon",
          "vormittags"
        ],
        "projekt": null,
        "frist": null
      },
      "content": null
    },
    {
      "path": "10_Aufgaben/plugin.md",
      "contentHash": "694f0a89",
      "frontmatter": {
        "title": "plugin-release-vorbereiten",
        "status": "aktiv",
        "priority": "hoch",
        "kontext": null,
        "projekt": "vault-crews",
        "frist": null
      },
      "content": null
    },
    {
      "path": "10_Aufgaben/steuer.md",
      "contentHash": "53378a49",
      "frontmatter": {
        "title": "steuererklarung-2025-einreichen",
        "status": "backlog",
        "priority": "mittel",
        "kontext": [],
        "projekt": "finanzen-2026",
        "frist": null
      },
      "content": null
    }
  ]
}
\`\`\`

## briefing

- Status: ok
- Dauer: 0.0 s
- Modell: test-model
- Prompt-Hash: 62d174bb

\`\`\`json
{
  "output": {
    "markdown": "## Heute fällig\\n- Plugin-Release vorbereiten\\n\\n## Überfällig\\nKeine überfälligen Aufgaben — alles im Rahmen.\\n\\n## Eine nächste Handlung\\nSteuererklärung 2025 einreichen."
  },
  "actions": [
    {
      "type": "section.replace",
      "path": "30_Chronos/10_Tage/<TODAY>.md",
      "content": "## Heute fällig\\n- Plugin-Release vorbereiten\\n\\n## Überfällig\\nKeine überfälligen Aufgaben — alles im Rahmen.\\n\\n## Eine nächste Handlung\\nSteuererklärung 2025 einreichen."
    }
  ]
}
\`\`\`

## apply

- Status: ok
- Dauer: 0.0 s

\`\`\`json
{
  "actions": [
    {
      "type": "section.replace",
      "path": "30_Chronos/10_Tage/<TODAY>.md",
      "content": "## Heute fällig\\n- Plugin-Release vorbereiten\\n\\n## Überfällig\\nKeine überfälligen Aufgaben — alles im Rahmen.\\n\\n## Eine nächste Handlung\\nSteuererklärung 2025 einreichen."
    }
  ]
}
\`\`\`

- ✓ section.replace 30_Chronos/10_Tage/<TODAY>.md

Commit: sha-1 — Undo: git revert sha-1
`;

const GOLDEN_COMMIT_MESSAGE = `crew(daily-briefing): run <RUN_ID> — ok, 1 Dateien

- 30_Chronos/10_Tage/<TODAY>.md
Run: _crews/runs/<RUN_ID>/run.md

Crew-Run: <RUN_ID>`;

const GOLDEN_COMMIT_PATHS: string[] = [
	'30_Chronos/10_Tage/<TODAY>.md',
	'_crews/runs/<RUN_ID>',
];
