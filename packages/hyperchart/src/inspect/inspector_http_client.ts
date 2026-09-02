import type { HyperchartInspectorDataSource } from "../host/adapter.js";

/** Browser-safe stateless transport for the inspector history contract. */
export function browserHistoryDataSource(token: string): HyperchartInspectorDataSource {
	const call = async <T,>(operation: string, input: unknown): Promise<T> => {
		const response = await fetch(`/api/runs/${token}/history`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ operation, input }),
		});
		const payload = await response.json() as { found?: boolean; result?: T; error?: string };
		if (!response.ok || typeof payload.found !== "boolean") throw new Error(payload.error ?? `History request failed (${response.status})`);
		return (payload.found ? payload.result : undefined) as T;
	};
	return {
		listBranches: (input) => call("listBranches", input),
		readStateVisits: (input) => call("readStateVisits", input),
		readMapVisits: (input) => call("readMapVisits", input),
		readActorGenerations: (input) => call("readActorGenerations", input),
		readActorMessages: (input) => call("readActorMessages", input),
		readRecords: (input) => call("readRecords", input),
		cursorAt: (input) => call("cursorAt", input),
		readVisitSession: (input) => call("readVisitSession", input),
	};
}
