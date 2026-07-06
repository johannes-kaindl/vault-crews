/** Orchestrator: die deterministische Run-Zustandsmaschine (Spec §3.1).
 *  IDLE → PREFLIGHT → RUNNING(1..n, sequenziell) → COMMITTING → DONE, mit
 *  REFUSED (Preflight) und FAILED/ABORTED (Partial-Commit, §5.3). Das LLM entscheidet
 *  nur Inhalte innerhalb enger Verträge; hier lebt Ablauf, Pfade, Schreibgrenzen.
 *  Pure: ausschließlich über injizierte Ports (ports.ts) — kein obsidian-Import. */
import { buildDenylist, expandTarget } from './paths';
import { parseAgentDef, parseTeamDef } from './crew-parser';
import { runCollector } from './collectors';
import { buildPrompt } from './prompt-builder';
import { BUILTIN_SCHEMAS } from './schemas';
import { buildRepairPrompt, validateOutput } from './output-validator';
import { executeActions, type ExecutorContext } from './action-executor';
import { buildRunMd, buildStateJson } from './run-log';
import { fnv1a } from './collectors';
import { normalizeEndpoint, resolveActiveEndpoint } from '../vendor/kit/endpoint';
import { LlmCallError } from './ports';
import type {
	ClockPort, LlmClient, LlmMessage, LlmParams, LlmStreamResult, MetadataPort, RunReporter, SnapshotStore, VaultPort,
} from './ports';
import type {
	Action, ActionsTaskDef, AgentDef, Artifact, CollectorTaskDef, ErrorKind, LlmTaskDef,
	RunLimits, RunResult, RunState, RunStatus, SlugTableData, TaskDef, TaskRecord, TeamDef,
} from './types';

export interface RunDeps {
	vault: VaultPort;
	meta: MetadataPort;
	llm: LlmClient;
	snapshot: SnapshotStore;
	clock: ClockPort;
	reporter: RunReporter;
	/** configDir: injiziert (Vault#configDir) für die Denylist — nicht im Skelett-RunDeps,
	 *  aber vom pure-Layer (buildDenylist) zwingend benötigt; Wiring liefert es in Task 16. */
	settings: {
		crewRoot: string;
		defaultModel: string;
		configDir: string;
		endpoints: string[];
		deniedEndpoints: string[];
		limits: RunLimits;
		undoHistoryDepth: number;
	};
	abort: AbortSignal;
}

type TaskStatus = TaskRecord['status'];
interface Refusal { kind: ErrorKind; message: string; }

const BUDGET_RESERVE = 0.15;
const CONTEXT_FALLBACK = 8192;

export function executeRun(teamPath: string, deps: RunDeps): Promise<RunResult> {
	return new RunFsm(teamPath, deps).run();
}

class RunFsm {
	private readonly state: RunState;
	private readonly denylist: string[];
	private limits: RunLimits;
	private readonly artifacts = new Map<string, Artifact>();
	private readonly agents = new Map<string, AgentDef>();
	private readonly modelCtx = new Map<string, number | null>();
	private team: TeamDef | null = null;
	private stopped = false;   // ein Task hat den Lauf abgebrochen (on_error abort / actions-Fail)
	private aborted = false;   // Watchdog / User-Abbruch

	constructor(private readonly teamPath: string, private readonly deps: RunDeps) {
		const now = deps.clock.now();
		const teamId = slugFromPath(teamPath);
		this.limits = deps.settings.limits;
		this.denylist = buildDenylist(deps.settings.configDir, deps.settings.crewRoot);
		this.state = {
			runId: formatRunId(now, teamId), teamId, teamPath,
			status: 'running', startedAt: now, endedAt: null,
			model: deps.settings.defaultModel, contextLength: null,
			writeRegister: [], llmCalls: 0, tasks: [], errorTask: null, errorKind: null,
		};
	}

	async run(): Promise<RunResult> {
		const refusal = await this.preflight();
		if (refusal !== null) return this.finishRefused(refusal);

		this.deps.reporter.emit({ type: 'runStarted', runId: this.state.runId, teamId: this.state.teamId });
		await this.taskLoop();
		await this.finalize();

		const result = this.result();
		this.deps.reporter.emit({ type: 'runFinished', result });
		return result;
	}

	// ── PREFLIGHT ────────────────────────────────────────────────────────────

	private async preflight(): Promise<Refusal | null> {
		return (
			(await this.parseTeamAndAgents())
			?? (await this.checkEndpointAndModel())
			?? (await this.acquireLock())
			?? (await this.openRun())
		);
	}

	private async parseTeamAndAgents(): Promise<Refusal | null> {
		const agentFolder = `${this.deps.settings.crewRoot}/agents`;
		let knownAgents: string[] = [];
		try {
			knownAgents = (await this.deps.meta.listMarkdownFiles(agentFolder)).map(slugFromPath);
		} catch { knownAgents = []; }

		const teamFm = await this.deps.meta.getFrontmatter(this.teamPath);
		const teamRes = parseTeamDef(this.teamPath, teamFm, { knownAgents, maxima: this.limits, denylist: this.denylist });
		if (!teamRes.ok) return { kind: 'crew_invalid', message: teamRes.errors.join('\n') };
		this.team = teamRes.value;

		const llmTasks = this.team.tasks.filter((t): t is LlmTaskDef => t.kind === 'llm');
		this.limits = { ...this.limits, maxLlmCalls: llmTasks.length * 2 };

		const errors: string[] = [];
		for (const agentId of new Set(llmTasks.map((t) => t.agent))) {
			const path = `${agentFolder}/${agentId}.md`;
			try {
				const fm = await this.deps.meta.getFrontmatter(path);
				const body = await this.deps.meta.getBody(path);
				const res = parseAgentDef(path, fm, body);
				if (res.ok) this.agents.set(agentId, res.value);
				else errors.push(...res.errors);
			} catch (e) {
				errors.push(`${path}: nicht lesbar (${errMsg(e)})`);
			}
		}
		if (errors.length > 0) return { kind: 'crew_invalid', message: errors.join('\n') };
		return null;
	}

	private async checkEndpointAndModel(): Promise<Refusal | null> {
		const denied = new Set(this.deps.settings.deniedEndpoints.map(normalizeEndpoint));
		const candidates = this.deps.settings.endpoints.filter((e) => !denied.has(normalizeEndpoint(e)));
		const active = await resolveActiveEndpoint(candidates, (e) => this.deps.llm.ping(e));
		if (active === null) return { kind: 'endpoint_unreachable', message: 'Kein erreichbarer LLM-Endpoint' };
		// Der resolveActiveEndpoint-Treffer ist per ping() bestätigt erreichbar — alle
		// nachfolgenden Calls (listModels/modelInfo/stream) MÜSSEN ihn auch tatsächlich
		// ansprechen, sonst bricht Multi-Endpoint-Failover (endpoints[0] tot, [1] lebt).
		this.deps.llm.setBase(active);

		try {
			const available = new Set(await this.deps.llm.listModels());
			for (const model of this.effectiveModels()) {
				if (!available.has(model)) return { kind: 'model_missing', message: `Modell nicht geladen: ${model}` };
				const info = await this.deps.llm.modelInfo(model);
				this.modelCtx.set(model, info?.contextLength ?? null);
			}
		} catch (e) {
			// Defense in depth: ein unerwarteter Netzwerk-Throw hier darf niemals uncaught
			// aus executeRun() entkommen (verletzt "ein fehlgeschlagener Lauf ist immer
			// sicher/geloggt") — auf denselben Refusal-Pfad wie ein erkannt-unerreichbarer
			// Endpoint abbilden.
			return { kind: 'endpoint_unreachable', message: `Endpoint-Abfrage fehlgeschlagen: ${errMsg(e)}` };
		}
		this.state.contextLength = this.modelCtx.get(this.deps.settings.defaultModel) ?? null;
		return null;
	}

	private async acquireLock(): Promise<Refusal | null> {
		const path = this.lockPath();
		if (await this.deps.vault.exists(path)) {
			if (await this.isLockHeld(path)) return { kind: 'io', message: 'Ein anderer Lauf ist aktiv (Run-Lock)' };
			await this.deps.vault.modify(path, this.lockContent());
		} else {
			await this.deps.vault.create(path, this.lockContent());
		}
		return null;
	}

	/** letzter Preflight-Schritt: Lauf im Vault sichtbar machen (run.md status running). */
	private async openRun(): Promise<Refusal | null> {
		this.state.status = 'running';
		await this.persist();
		return null;
	}

	// ── RUNNING ──────────────────────────────────────────────────────────────

	private async taskLoop(): Promise<void> {
		const tasks = this.team?.tasks ?? [];
		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			if (task === undefined) continue;

			if (this.deps.clock.now() - this.state.startedAt > this.limits.wallClockMs) {
				this.abortRun(task.id, 'Watchdog: Wanduhr-Limit überschritten');
				break;
			}
			if (this.deps.abort.aborted) {
				this.abortRun(task.id, 'Lauf vom Benutzer abgebrochen');
				break;
			}

			const startedAt = this.deps.clock.now();
			this.deps.reporter.emit({ type: 'taskStarted', taskId: task.id, index: i + 1, total: tasks.length });
			const rec: TaskRecord = {
				taskId: task.id, kind: task.kind, status: 'ok', startedAt, endedAt: startedAt,
				model: null, promptHash: null, thinkTokens: 0, artifactJson: null, outcomes: [], error: null,
			};

			rec.status = await this.runTask(task, rec);
			rec.endedAt = this.deps.clock.now();
			this.state.tasks.push(rec);
			await this.persist();
			this.deps.reporter.emit({ type: 'taskFinished', taskId: task.id, status: rec.status });

			if (this.stopped || this.aborted) break;
		}
	}

	private runTask(task: TaskDef, rec: TaskRecord): Promise<TaskStatus> {
		switch (task.kind) {
			case 'collector': return this.runCollectorTask(task, rec);
			case 'llm': return this.runLlmTask(task, rec);
			case 'actions': return this.runActionsTask(task, rec);
		}
	}

	private async runCollectorTask(task: CollectorTaskDef, rec: TaskRecord): Promise<TaskStatus> {
		try {
			const artifact = await runCollector(task, { vault: this.deps.vault, meta: this.deps.meta, denylist: this.denylist });
			this.artifacts.set(task.id, artifact);
			rec.artifactJson = artifact.json;
			return 'ok';
		} catch (e) {
			return this.failTask(task.id, rec, 'io', `Collector fehlgeschlagen: ${errMsg(e)}`);
		}
	}

	private async runLlmTask(task: LlmTaskDef, rec: TaskRecord): Promise<TaskStatus> {
		const inputs = this.inputArtifacts(task);
		if (inputs === null) return 'skipped';   // Upstream übersprungen/fehlgeschlagen → Kaskade

		const agent = this.agents.get(task.agent);
		if (agent === undefined) return this.failLlm(task, rec, 'crew_invalid', `Agent nicht geladen: ${task.agent}`);
		rec.model = agent.model ?? this.deps.settings.defaultModel;

		const schema = BUILTIN_SCHEMAS[task.outputSchema];
		const sources = inputs.flatMap((a) => a.files);
		const slugTables = mergeSlugTables(inputs);
		const target = this.resolveTarget(task);
		const ctxLen = this.modelCtx.get(rec.model) ?? CONTEXT_FALLBACK;
		const budget = Math.max(1, ctxLen - agent.maxTokens - Math.floor(ctxLen * BUDGET_RESERVE));
		const params: LlmParams = { model: rec.model, temperature: agent.temperature, maxTokens: agent.maxTokens, thinking: agent.thinking };

		// Primärer Call mit genau einem reaktiven Overflow-Retry (Material halbieren).
		let result: LlmStreamResult;
		let overflowRetried = false;
		for (;;) {
			const b = overflowRetried ? Math.max(1, Math.floor(budget / 2)) : budget;
			try {
				const prompt = buildPrompt(agent, task, inputs, schema, b);
				rec.promptHash = prompt.promptHash;
				result = await this.stream(prompt.messages, params, task.id);
			} catch (e) {
				if (e instanceof LlmCallError && e.kind === 'overflow' && !overflowRetried) {
					overflowRetried = true;
					continue;
				}
				return this.failLlm(task, rec, llmErrorKind(e), errMsg(e));
			}
			break;
		}
		rec.thinkTokens += result.thinkTokens;
		if (result.finishReason === 'aborted') { this.abortRun(task.id, 'Stream abgebrochen'); rec.error = { kind: 'aborted', message: 'Stream abgebrochen' }; return 'failed'; }

		let validated = validateOutput(result.content, schema, sources, slugTables, target);
		if (!validated.ok) await this.writeArtifact(task.id, 1, result.content);
		if (!validated.ok && this.state.llmCalls < this.limits.maxLlmCalls) {
			// genau ein Repair-Zyklus
			try {
				const repair = await this.stream(buildRepairPrompt(result.content, validated.errors), params, task.id);
				rec.thinkTokens += repair.thinkTokens;
				if (repair.finishReason === 'aborted') { this.abortRun(task.id, 'Stream abgebrochen'); rec.error = { kind: 'aborted', message: 'Stream abgebrochen' }; return 'failed'; }
				validated = validateOutput(repair.content, schema, sources, slugTables, target);
				if (!validated.ok) await this.writeArtifact(task.id, 2, repair.content);
			} catch (e) {
				return this.failLlm(task, rec, llmErrorKind(e), errMsg(e));
			}
		}
		if (!validated.ok) return this.failLlm(task, rec, 'invalid_output', validated.errors.join('; '));

		// Zusatz-Vertrag: llm-Artifact.json = { output, actions }; files/slugTables geerbt.
		const artifact: Artifact = { taskId: task.id, json: { output: validated.json, actions: validated.actions }, files: sources, slugTables };
		this.artifacts.set(task.id, artifact);
		rec.artifactJson = artifact.json;
		return 'ok';
	}

	private async runActionsTask(task: ActionsTaskDef, rec: TaskRecord): Promise<TaskStatus> {
		const inputs = this.inputArtifacts(task);
		if (inputs === null) return 'skipped';   // Upstream übersprungen/fehlgeschlagen → Kaskade

		const actions = inputs.flatMap(artifactActions);
		const ctx: ExecutorContext = {
			team: this.team as TeamDef, task, limits: this.limits,
			writeCount: this.uniqueWrites().length,
			sources: inputs.flatMap((a) => a.files),
			slugTables: mergeSlugTables(inputs),
			denylist: this.denylist,
			// Copy-on-Write: Pre-Image sichern, BEVOR der Executor schreibt (first-write-wins
			// macht der Store). Ein Throw hier → Aktion failed, nie Write ohne Sicherheitsnetz.
			preWrite: async (path) => {
				const existed = await this.deps.vault.exists(path);
				const pre = existed ? await this.deps.vault.read(path) : null;
				await this.deps.snapshot.capture(this.state.runId, this.state.teamId, this.state.startedAt, path, existed, pre);
			},
		};
		const { outcomes, writes, taskFailed } = await executeActions(actions, ctx, this.deps.vault);
		rec.outcomes = outcomes;
		rec.artifactJson = { actions };
		for (const outcome of outcomes) this.deps.reporter.emit({ type: 'actionApplied', outcome });
		for (const w of writes) if (!this.state.writeRegister.includes(w)) this.state.writeRegister.push(w);

		if (taskFailed) {
			const kind = actionsErrorKind(outcomes);
			return this.failTask(task.id, rec, kind, `Aktions-Task fehlgeschlagen (${kind})`);
		}
		return 'ok';
	}

	// ── COMMITTING ─────────────────────────────────────────────────────────────

	private async finalize(): Promise<void> {
		await this.releaseLock();                 // Lock liegt außerhalb runDir
		this.state.status = this.finalStatus();
		this.state.endedAt = this.deps.clock.now();
		await this.persist();                      // run.md/state.json mit finalem Status (undoable steht drin)

		const written = this.uniqueWrites();
		if (written.length > 0) {
			// Post-Run-Hashes je geschriebenem Pfad für die Konflikt-Erkennung beim Undo
			// (Note nach dem Lauf manuell editiert?). Ein seither entfernter Pfad → kein postHash.
			const postHashes: Record<string, string> = {};
			for (const p of written) {
				try { postHashes[p] = fnv1a(await this.deps.vault.read(p)); } catch { /* seither entfernt */ }
			}
			try {
				await this.deps.snapshot.finalize(this.state.runId, postHashes, this.deps.settings.undoHistoryDepth);
			} catch (e) {
				// Snapshot-Finalize ist nachgelagert; Wirkung ist im Vault. Protokollieren, nicht crashen.
				if (this.state.errorKind === null) { this.state.errorKind = 'io'; }
				this.state.tasks.push(protocolFailure(this.deps.clock.now(), 'io', `Snapshot-Finalize fehlgeschlagen: ${errMsg(e)}`));
				await this.persist();
			}
		}
	}

	// ── Terminierung ────────────────────────────────────────────────────────

	private async finishRefused(refusal: Refusal): Promise<RunResult> {
		this.state.status = 'refused';
		this.state.errorKind = refusal.kind;
		this.state.endedAt = this.deps.clock.now();
		this.state.tasks.push(protocolFailure(this.state.endedAt, refusal.kind, refusal.message));
		try { await this.persist(); } catch { /* best effort: Refusal-Grund steht in errorKind */ }
		const result = this.result();
		this.deps.reporter.emit({ type: 'runFinished', result });
		return result;
	}

	private finalStatus(): RunStatus {
		if (this.aborted) return 'aborted';
		if (this.stopped) return 'failed';
		const degraded = this.state.tasks.some(
			(t) => t.status === 'skipped' || t.outcomes.some((o) => o.result !== 'applied'),
		);
		return degraded ? 'partial' : 'ok';
	}

	private result(): RunResult {
		const status = this.state.status === 'running' ? 'failed' : this.state.status;
		return {
			runId: this.state.runId,
			status,
			undoable: this.uniqueWrites().length > 0,
			writes: this.uniqueWrites().length,
			durationS: this.state.endedAt === null ? 0 : Math.round((this.state.endedAt - this.state.startedAt) / 1000),
			errorTask: this.state.errorTask,
			errorKind: this.state.errorKind,
		};
	}

	// ── Helfer ───────────────────────────────────────────────────────────────

	private effectiveModels(): Set<string> {
		const out = new Set<string>();
		for (const task of this.team?.tasks ?? []) {
			if (task.kind !== 'llm') continue;
			out.add(this.agents.get(task.agent)?.model ?? this.deps.settings.defaultModel);
		}
		if (out.size === 0) out.add(this.deps.settings.defaultModel);
		return out;
	}

	/** Ziel des llm-Tasks = target des (eindeutigen) späteren actions-Tasks, der ihn konsumiert,
	 *  expandiert via ClockPort; sonst null (Integrationsentscheidung des Controllers). */
	private resolveTarget(llmTask: LlmTaskDef): string | null {
		const consumer = (this.team?.tasks ?? []).find(
			(t): t is ActionsTaskDef => t.kind === 'actions' && t.inputs.includes(llmTask.id),
		);
		if (consumer === undefined || consumer.target === null) return null;
		return expandTarget(consumer.target, this.deps.clock.now());
	}

	private inputArtifacts(task: LlmTaskDef | ActionsTaskDef): Artifact[] | null {
		const out: Artifact[] = [];
		for (const id of task.inputs) {
			const a = this.artifacts.get(id);
			if (a === undefined) return null;   // Upstream übersprungen/fehlgeschlagen → Kaskade
			out.push(a);
		}
		return out;
	}

	private async stream(messages: LlmMessage[], params: LlmParams, taskId: string): Promise<LlmStreamResult> {
		if (this.state.llmCalls >= this.limits.maxLlmCalls) {
			throw new LlmCallError(`LLM-Call-Limit erreicht (${this.limits.maxLlmCalls})`, 'http');
		}
		this.state.llmCalls += 1;
		return this.deps.llm.stream(
			messages, params,
			() => this.deps.reporter.emit({ type: 'token', taskId, isThink: false }),
			this.deps.abort,
		);
	}

	private failLlm(task: LlmTaskDef, rec: TaskRecord, kind: ErrorKind, message: string): TaskStatus {
		rec.error = { kind, message };
		if (task.onError === 'skip') return 'skipped';
		this.state.errorTask = task.id;
		this.state.errorKind = kind;
		this.stopped = true;
		return 'failed';
	}

	private failTask(taskId: string, rec: TaskRecord, kind: ErrorKind, message: string): TaskStatus {
		rec.error = { kind, message };
		this.state.errorTask = taskId;
		this.state.errorKind = kind;
		this.stopped = true;
		return 'failed';
	}

	private abortRun(taskId: string, _message: string): void {
		this.aborted = true;
		this.state.errorTask = taskId;
		this.state.errorKind = 'aborted';
	}

	private uniqueWrites(): string[] {
		return [...new Set(this.state.writeRegister)];
	}

	private runDir(): string { return `${this.deps.settings.crewRoot}/runs/${this.state.runId}`; }
	// Non-dotfile: Obsidian's TFile-Index (getAbstractFileByPath, siehe ObsidianVaultPort)
	// indiziert keine Dotfiles → vault.read/modify würden auf `.lock` zur Laufzeit werfen.
	// create/exists/mkdir laufen über vault.adapter und funktionieren mit Dotfiles, aber
	// releaseLock() (modify) braucht denselben Pfad wie acquireLock() — also non-dotfile.
	private lockPath(): string { return `${this.deps.settings.crewRoot}/runs/run-lock.json`; }
	private lockContent(): string { return JSON.stringify({ active: true, runId: this.state.runId, startedAt: this.state.startedAt }); }

	private async isLockHeld(path: string): Promise<boolean> {
		try {
			const parsed: unknown = JSON.parse(await this.deps.vault.read(path));
			if (!isRecord(parsed) || parsed.active === false || typeof parsed.startedAt !== 'number') return false;
			return this.deps.clock.now() - parsed.startedAt <= this.limits.wallClockMs;
		} catch {
			return false;   // korrupt → verwaist, übernehmen
		}
	}

	private async releaseLock(): Promise<void> {
		const path = this.lockPath();
		try {
			if (await this.deps.vault.exists(path)) await this.deps.vault.modify(path, JSON.stringify({ active: false }));
		} catch { /* best effort */ }
	}

	private async persist(): Promise<void> {
		const dir = this.runDir();
		try { await this.deps.vault.mkdir(dir); } catch { /* existiert bereits */ }
		await this.writeFile(`${dir}/run.md`, buildRunMd(this.state));
		await this.writeFile(`${dir}/state.json`, buildStateJson(this.state));
	}

	private async writeFile(path: string, content: string): Promise<void> {
		if (await this.deps.vault.exists(path)) await this.deps.vault.modify(path, content);
		else await this.deps.vault.create(path, content);
	}

	/** Rohen LLM-Output bei Validierungs-/Repair-Fehlschlag ablegen (Spec §2.4, §3.4 Schritt 4,
	 *  §9: „fehlerfall-artifacts"). Fixture-Korpus, kein Vault-Write des Modells: NICHT im
	 *  writeRegister, zählt nicht gegen max_writes — der runDir-Verzeichnis-Pathspec
	 *  (git-plan.ts) staged artifacts/ trotzdem automatisch für den Commit. */
	private async writeArtifact(taskId: string, attempt: 1 | 2, content: string): Promise<void> {
		const dir = `${this.runDir()}/artifacts`;
		try { await this.deps.vault.mkdir(dir); } catch { /* existiert bereits */ }
		await this.writeFile(`${dir}/${taskId}-${attempt}.txt`, content);
	}
}

// ── freie Helfer ─────────────────────────────────────────────────────────────

function slugFromPath(path: string): string {
	return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

function formatRunId(nowMs: number, teamId: string): string {
	const d = new Date(nowMs);
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${teamId}`;
}

function mergeSlugTables(inputs: Artifact[]): Record<string, SlugTableData> {
	const out: Record<string, SlugTableData> = {};
	for (const a of inputs) for (const [key, table] of Object.entries(a.slugTables)) if (!(key in out)) out[key] = table;
	return out;
}

function artifactActions(a: Artifact): Action[] {
	const j = a.json;
	if (isRecord(j) && Array.isArray(j.actions)) return j.actions as Action[];
	return [];
}

function actionsErrorKind(outcomes: { reason: string | null }[]): ErrorKind {
	const reasons = outcomes.map((o) => o.reason ?? '');
	if (reasons.some((r) => r.includes('write_limit'))) return 'write_limit';
	if (reasons.some((r) => r.includes('consistency'))) return 'consistency';
	return 'io';
}

function llmErrorKind(e: unknown): ErrorKind {
	if (e instanceof LlmCallError) {
		switch (e.kind) {
			case 'overflow': return 'context_overflow';
			case 'timeout': return 'timeout';
			case 'stalled': return 'stalled';
			case 'http': return 'endpoint_unreachable';
		}
	}
	return 'io';
}

/** Synthetischer Protokoll-Eintrag für Preflight-Verweigerungen / Commit-Fehler:
 *  surft den Grund in run.md, ohne einen echten Task zu erfinden (taskId 'preflight'). */
function protocolFailure(atMs: number, kind: ErrorKind, message: string): TaskRecord {
	return {
		taskId: 'preflight', kind: 'collector', status: 'failed', startedAt: atMs, endedAt: atMs,
		model: null, promptHash: null, thinkTokens: 0, artifactJson: null, outcomes: [],
		error: { kind, message },
	};
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
