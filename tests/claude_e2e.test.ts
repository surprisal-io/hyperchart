import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";
import { readNeutralSessionTranscript } from "../packages/hyperchart/src/inspect/session_transcript.js";
import { createHyperchartMcpTools } from "../packages/claude-hyperchart/src/mcp/tools.js";

// Opt-in end-to-end run against the real Claude Agent SDK (spawns Claude Code,
// uses the machine's credentials, spends tokens): HYPERCHART_E2E=1 npm test
const enabled = process.env.HYPERCHART_E2E === "1";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!enabled)("claude e2e", () => {
	it("runs a one-agent chart through the real SDK to a validated finish", async () => {
		const root = mkdtempSync(join(tmpdir(), "claude-e2e-"));
		roots.push(root);
		const cwd = join(root, "project");
		const chartsDir = join(cwd, ".claude", "hypercharts", "e2e");
		mkdirSync(join(chartsDir, "agents"), { recursive: true });
		writeFileSync(
			join(chartsDir, "agents", "finisher.md"),
			"---\nname: finisher\nthinking: low\n---\nYou complete hyperchart steps. Follow the completion contract exactly and finish immediately without using any other tools.\n",
		);
		writeFileSync(
			join(chartsDir, "chart.ts"),
			`import { chart, agent, final } from "@surprisal/hyperchart";
export default chart({
	kind: "chart",
	id: "e2e",
	initial: "work",
	states: {
		work: {
			kind: "state",
			action: agent("finisher", { task: "Reply DONE via the finish tool immediately. Do not read or write any files." }),
			transitions: { DONE: "done", FAILED: "failed" },
		},
		done: final(),
		failed: failed(),
	},
});
`,
		);
		const runsRoot = join(root, "runs");
		const tools = new Map(createHyperchartMcpTools({ cwd, runsRoot }).map((tool) => [tool.name, tool]));

		const result = await tools.get("hyperchart_run")!.handler({ chartPath: "e2e", wait: true });
		const run = JSON.parse(result.content[0]?.text ?? "{}") as {
			runId: string;
			runDir: string;
			status: { state: string; error?: string };
		};
		if (run.status.state !== "complete") {
			const stderr = readFileSync(join(run.runDir, "runner.stderr.log"), "utf8");
			throw new Error(`run ended ${run.status.state}: ${run.status.error}\n${stderr.slice(-2000)}`);
		}

		const log = readFileSync(join(run.runDir, "log.jsonl"), "utf8");
		expect(log).toContain('"DONE"');
		const sessionsDir = join(run.runDir, "sessions");
		const progress = Object.values(readSessionProgress(sessionsDir).sessions)[0];
		expect(progress?.status).toBe("completed");
		const transcript = readNeutralSessionTranscript(sessionsDir, progress?.sessionFile);
		expect(transcript?.some((entry) => entry.role === "tool" && entry.toolName === "finish")).toBe(true);
	}, 600_000);
});
