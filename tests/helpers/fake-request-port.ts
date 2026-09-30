import type { RequestPort } from '../../src/core/ports';
import type { BackendId, Deviation, FamilyId } from '../../src/vendor/kit/sampling-profiles';
import { describeModel } from '../../src/vendor/kit/endpoint-source';

/** Test-Double für den `RequestPort` (Orchestrator): Familie aus dem Namen wie im Plugin ohne Manager,
 *  Backend fest vorgegeben, und alles festgehalten, was der Orchestrator meldet. */
export interface FakeRequestPort extends RequestPort {
	recorded: Array<Record<string, number | string>>;
	reported: Deviation[][];
	backendAsked: string[];
}

export function fakeRequestPort(opts: { backend?: BackendId; family?: FamilyId | null } = {}): FakeRequestPort {
	const port: FakeRequestPort = {
		recorded: [],
		reported: [],
		backendAsked: [],
		describe(model) {
			const d = describeModel(model, undefined);
			return { family: opts.family !== undefined ? opts.family : d.family, sentModel: d.sentModel };
		},
		backendOf(endpoint) {
			port.backendAsked.push(endpoint.url);
			return Promise.resolve(opts.backend ?? 'unknown');
		},
		recordRequest(params) { port.recorded.push(params); },
		report(ds) { port.reported.push(ds); },
	};
	return port;
}
