/** Heartbeat: Crews mit `trigger: interval` laufen wiederkehrend ohne Menschen (Dach-AGENTS
 *  § Zuständigkeits-Zuschnitt). Rein: Zeit kommt als Parameter, Zustand als Map. */

/** Untergrenze, damit ein Tippfehler (`1m`) keinen Dauerlauf gegen das Modell auslöst. */
export const MIN_INTERVAL_MINUTES = 5;

const UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440 };

/** `30m`, `2h`, `1d` → Minuten; alles andere (und alles unter dem Minimum) → null. */
export function parseIntervalMinutes(raw: unknown): number | null {
	if (typeof raw !== 'string') return null;
	const m = /^(\d+)([mhd])$/.exec(raw.trim().toLowerCase());
	if (m === null) return null;
	const minutes = Number(m[1]) * (UNIT_MINUTES[m[2]] ?? 0);
	return minutes >= MIN_INTERVAL_MINUTES ? minutes : null;
}

export interface IntervalTeam { id: string; intervalMinutes: number; }

/** Gibt die fälligen Team-IDs zurück. `lastStart` hält je Team den Zeitpunkt (ms), ab dem
 *  gezählt wird: beim ersten Sehen die Gegenwart (kein Lauf beim Plugin-Start), danach der
 *  Zeitpunkt, den der Aufrufer mit `lastStart.set` setzt. Entfernte Teams fallen heraus. */
export function dueTeams(teams: IntervalTeam[], lastStart: Map<string, number>, now: number): string[] {
	const live = new Set(teams.map((t) => t.id));
	for (const id of [...lastStart.keys()]) if (!live.has(id)) lastStart.delete(id);
	const due: string[] = [];
	for (const team of teams) {
		const last = lastStart.get(team.id);
		if (last === undefined) { lastStart.set(team.id, now); continue; }
		if (now - last >= team.intervalMinutes * 60_000) due.push(team.id);
	}
	return due;
}
