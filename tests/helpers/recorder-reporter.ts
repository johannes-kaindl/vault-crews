import type { RunEvent, RunReporter } from '../../src/core/ports';

export class RecorderReporter implements RunReporter {
	readonly events: RunEvent[] = [];
	emit(e: RunEvent): void { this.events.push(e); }

	types(): string[] { return this.events.map((e) => e.type); }
}
