import { basename as fixtureRunId, dirname as fixtureRoot } from "node:path";
import { withRunStorage, type RunStorage } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { createRunInspectorDataSource } from "../packages/hyperchart/src/inspect/run_history.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseChartModuleSync } from "../packages/hyperchart/src/core/inspect.js";
import { createBranchProjection } from "../packages/hyperchart/src/core/projection.js";
import type { Effect, MachineEvent } from "../packages/hyperchart/src/core/machine.js";
import { hyperchartRunFromRunId } from "../packages/hyperchart/src/inspect/run_inspect.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { loop } from "./helpers/execution.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("restores an unanswered gate without future action state, transcripts or moving the branch", async () => {
	vi.stubEnv("HYPERCHART_PG_DSN", "");
	const root = mkdtempSync(join(tmpdir(), "hyperchart-pinned-gate-"));
	roots.push(root);
	const runDir = join(root, "run");
	mkdirSync(runDir);
	const chartPath = join(root, "chart.ts");
	writeFileSync(
		chartPath,
		`import { chart, agent, user, final } from "@surprisal/hyperchart";
 export default chart({kind:"chart",id:"pinned-gate",initial:"generate",states:{
 generate:{kind:"state",action:agent("generator"),transitions:{DONE:"choose"}},
 choose:{kind:"state",action:user({prompt:"Select candidate",options:["SELECTED"]}),transitions:{SELECTED:"work"}},
 work:{kind:"state",action:agent("worker"),transitions:{DONE:"done"}},done:final()}});`,
	);
	const parsed = parseChartModuleSync(chartPath);
	if (!parsed.ok) throw new Error("Invalid fixture chart");
	const ast = parsed.ast;
	const store = new JsonlLogStore(join(runDir, "log.jsonl"));
	await store.writeRunMeta({ chartPath, workDir: root, chartId: ast.id, createdAt: new Date(0).toISOString() });
	await store.initializeRootBranch();
	const queued: MachineEvent[] = [];
	let wake: (() => void) | undefined;
	const push = (event: MachineEvent) => {
		queued.push(event);
		wake?.();
		wake = undefined;
	};
	let gateSeqId = 0;
	const runtime = {
		branchId: "main",
		async loadAst() {
			return ast;
		},
		async loadProjection() {
			return createBranchProjection(ast);
		},
		async runEffects(effects: Effect[]) {
			for (const effect of effects) {
				switch (effect.kind) {
					case "durable_records": {
						const records = await store.appendDrafts(effect.records);
						push({ kind: "durable_records_added", effectId: effect.id, records });
						for (const record of records) {
							if (record.type === "user_interaction" && record.kind === "opened") {
								gateSeqId = record.seqId;
								const response = await store.appendDrafts([
									{
										type: "user_interaction",
										kind: "resolved",
										gateSeqId,
										actionUid: record.actionUid,
										event: { type: "SELECTED" },
									},
								]);
								push({ kind: "durable_records_added", effectId: `external:${gateSeqId}`, records: response });
							}
						}
						break;
					}
					case "agent":
						push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "DONE" } } });
						break;
					case "cancel":
						break;
					default:
						throw new Error(`Unexpected fixture effect ${effect.kind}`);
				}
			}
		},
		async *eventsQueue(): AsyncIterable<MachineEvent> {
			while (true) {
				if (queued.length === 0)
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				const event = queued.shift();
				if (event !== undefined) yield event;
			}
		},
	};
	await loop(runtime);
	expect(gateSeqId).toBeGreaterThan(0);
	const before = await store.captureSnapshot("main");
	const readTranscript = vi.fn(async () => [
		{ id: "future", role: "assistant" as const, text: "future session message", timestamp: Number.MAX_SAFE_INTEGER },
	]);
	const historical = await withRunStorage(fixtureStorage(runDir), () => hyperchartRunFromRunId(fixtureRunId(runDir), {
		ast,
		snapshot: { branchId: "main", headSeqId: gateSeqId },
		includeTranscripts: true,
		readTranscript,
	}));
	expect(historical.states.find((state) => state.id === "choose")?.status).toBe("waiting");
	expect(historical.states.find((state) => state.id === "work")?.status).toBe("pending");
	expect(historical.historySnapshot).toEqual({ branchId: "main", headSeqId: gateSeqId });
	expect(historical.branches?.find((branch) => branch.branchId === "main")?.headSeqId).toBe(gateSeqId);
	expect(readTranscript).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(historical)).not.toContain("future session message");
	const generate = historical.states.find(state => state.id === "generate")!.visitHistory![0]!;
	const work = (await store.readRecords({ snapshot: before })).items.find(record => record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "work")!;
	const finalTranscript = vi.fn(async () => [{ id: "finish", role: "tool" as const, toolName: "finish", toolStatus: "completed" as const, timestamp: generate.endedAt!, toolOutput: "Recorded" }, { id:"later", role:"assistant" as const, text:"future", timestamp:Number.MAX_SAFE_INTEGER }]);
	const source = await withRunStorage(fixtureStorage(runDir), () => createRunInspectorDataSource(fixtureRunId(runDir), { ast, readTranscript: finalTranscript }));
	const session = await source.readVisitSession({ runId: "run", snapshot: historical.historySnapshot!, invokeSeqId: generate.invokeSeqId });
	expect(session).toMatchObject({ status: "completed", messages: [{ id: "finish", toolName: "finish", toolStatus: "completed" }] });
	await expect(source.readVisitSession({ runId: "run", snapshot: historical.historySnapshot!, invokeSeqId: work.seqId })).resolves.toBeUndefined();
	expect(await store.captureSnapshot("main")).toEqual(before);
	const current = await withRunStorage(fixtureStorage(runDir), () => hyperchartRunFromRunId(fixtureRunId(runDir), { ast, includeTranscripts: true, readTranscript }));
	expect(current.states.find((state) => state.id === "work")?.status).toBe("done");
	await expect(
		withRunStorage(fixtureStorage(runDir), () => hyperchartRunFromRunId(fixtureRunId(runDir), {
			ast,
			branchId: "different",
			snapshot: { branchId: "main", headSeqId: gateSeqId },
		})),
	).rejects.toThrow("does not match");
	await store.close();
});

/** Explicit storage configuration for this suite's generated literal-layout fixtures. */
function fixtureStorage(runDirectory: string): RunStorage {
 return {kind: "jsonl", rootDir: fixtureRoot(runDirectory), layout: "run-id"};
}
