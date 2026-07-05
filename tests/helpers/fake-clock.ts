import type { ClockPort } from '../../src/core/ports';

export class FakeClock implements ClockPort {
	private t: number;
	private nextId = 1;
	private timers = new Map<number, { at: number; fn: () => void }>();

	constructor(startMs = 0) { this.t = startMs; }

	now(): number { return this.t; }

	setTimeout(fn: () => void, ms: number): number {
		const id = this.nextId++;
		this.timers.set(id, { at: this.t + ms, fn });
		return id;
	}
	clearTimeout(id: number): void { this.timers.delete(id); }

	/** Zeit vorspulen; fällige Timer in at-Reihenfolge ausführen. */
	tick(ms: number): void {
		const target = this.t + ms;
		for (;;) {
			const due = [...this.timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.t = due[1].at;
			due[1].fn();
		}
		this.t = target;
	}
}
