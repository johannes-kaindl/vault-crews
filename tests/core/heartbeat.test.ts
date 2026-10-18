import { describe, expect, it } from 'vitest';
import { MIN_INTERVAL_MINUTES, dueTeams, parseIntervalMinutes } from '../../src/core/heartbeat';

describe('parseIntervalMinutes', () => {
	it('liest Minuten, Stunden und Tage', () => {
		expect(parseIntervalMinutes('30m')).toBe(30);
		expect(parseIntervalMinutes('2h')).toBe(120);
		expect(parseIntervalMinutes('1d')).toBe(1440);
		expect(parseIntervalMinutes(' 15M ')).toBe(15);
	});
	it('lehnt Unsinn und Werte unter dem Minimum ab', () => {
		for (const bad of ['', 'abc', '30', '1.5h', '-5m', '0m', `${MIN_INTERVAL_MINUTES - 1}m`, 30, null, undefined]) {
			expect(parseIntervalMinutes(bad)).toBeNull();
		}
	});
	it('nimmt das Minimum selbst an', () => {
		expect(parseIntervalMinutes(`${MIN_INTERVAL_MINUTES}m`)).toBe(MIN_INTERVAL_MINUTES);
	});
});

describe('dueTeams', () => {
	const MIN = 60_000;
	it('startet nie sofort: der erste Takt zählt ab dem Anmeldezeitpunkt', () => {
		const state = new Map<string, number>();
		expect(dueTeams([{ id: 'a', intervalMinutes: 10 }], state, 1000)).toEqual([]);
		expect(state.get('a')).toBe(1000);
	});
	it('meldet fällig, wenn das Intervall seit dem letzten Start verstrichen ist', () => {
		const state = new Map([['a', 0]]);
		const teams = [{ id: 'a', intervalMinutes: 10 }];
		expect(dueTeams(teams, state, 9 * MIN)).toEqual([]);
		expect(dueTeams(teams, state, 10 * MIN)).toEqual(['a']);
	});
	it('vergisst Teams, die kein Intervall mehr tragen', () => {
		const state = new Map([['alt', 0]]);
		dueTeams([], state, 5);
		expect(state.has('alt')).toBe(false);
	});
});
