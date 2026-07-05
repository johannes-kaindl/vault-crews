import type { CommitPlan, GitPort, GitStatusInfo } from '../../src/core/ports';

export class RecorderGitPort implements GitPort {
	readonly log: string[] = [];
	readonly plans: CommitPlan[] = [];
	statusInfo: GitStatusInfo = { isRepo: true, inMergeOrRebase: false, hasIndexLock: false, headSha: 'base-sha', dirty: false };
	revertResult: { ok: boolean; conflictPaths: string[] } = { ok: true, conflictPaths: [] };
	private commitN = 0;

	async status(): Promise<GitStatusInfo> {
		this.log.push('status');
		return this.statusInfo;
	}
	async applyPlan(plan: CommitPlan): Promise<string> {
		this.plans.push(plan);
		this.commitN += 1;
		const sha = `sha-${this.commitN}`;
		this.log.push(`applyPlan:${sha}`);
		return sha;
	}
	async revert(sha: string): Promise<{ ok: boolean; conflictPaths: string[] }> {
		this.log.push(`revert:${sha}`);
		return this.revertResult;
	}
	async restorePaths(sha: string, paths: string[]): Promise<void> {
		this.log.push(`restorePaths:${sha}:${paths.join(',')}`);
	}
}
