import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { JsonlLogStore } from "@surprisal/hyperchart/runtime";
import { buildRunView } from "../packages/pi-hyperchart/src/tui/run_view.js";
import { readRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import { readSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";
import { hyperchartRunFromRunDir } from "../packages/pi-hyperchart/src/runtime/pi/run_inspect.js";
import { summarizeHyperchartProgress } from "../packages/hyperchart/src/host/run_progress.js";
import {
	cleanupProductionTuiFixture,
	materializeProductionTuiFixture,
	type ProductionTuiFixture,
} from "../.storybook/tui-production-fixture.js";

let fixture: ProductionTuiFixture | undefined;

afterEach(() => {
	cleanupProductionTuiFixture(fixture);
	fixture = undefined;
});

describe("Storybook production TUI fixture", () => {
	it("uses valid run status, durable log, progress, and Pi v3 session files", async () => {
		fixture = materializeProductionTuiFixture();
		for (const item of fixture.history) {
			const status = readRunStatus(item.runDir);
			expect(status).toMatchObject({
				version: 1,
				runId: item.runId,
				branchId: "main",				runDir: item.runDir,
				chartId: fixture.ast.id,
				state: item.state,
			});
			const log = await new JsonlLogStore(join(item.runDir, "log.jsonl")).readAll();
			const view = buildRunView(fixture.ast, log, Date.UTC(2026, 6, 14, 12, 0, 0));
			expect(view.final).toBe(false);
			expect(view.pending.some((entry) => entry.path === "research#market.scout")).toBe(true);
			const progress = readSessionProgress(join(item.runDir, "sessions"));
			expect(Object.keys(progress.sessions)).toHaveLength(3);
			for (const session of Object.values(progress.sessions)) {
				expect(session.sessionFile).toBeDefined();
				const header = JSON.parse(readFileSync(session.sessionFile!, "utf8").split("\n")[0]!) as Record<string, unknown>;
				expect(header).toMatchObject({ type: "session", version: 3 });
				expect(() => SessionManager.open(session.sessionFile!)).not.toThrow();
			}
		}
	});

	it("includes a many-running widget variant with shared percentage progress", async () => {
		fixture = materializeProductionTuiFixture();
		const progress = readSessionProgress(join(fixture.manyRunning.runDir, "sessions"));
		expect(Object.values(progress.sessions).filter((session) => session.status === "running")).toHaveLength(8);
		const run = await hyperchartRunFromRunDir(fixture.manyRunning.runDir);
		const summary = summarizeHyperchartProgress(run);
		expect(summary.pct).toBeGreaterThan(0);
		expect(summary.pct).toBeLessThan(100);
	});

	it("materializes isolated run roots for concurrent Storybook processes", () => {
		fixture = materializeProductionTuiFixture();
		const other = materializeProductionTuiFixture();
		try {
			expect(other.root).not.toBe(fixture.root);
			cleanupProductionTuiFixture(fixture);
			expect(existsSync(other.primary.logPath)).toBe(true);
		} finally {
			cleanupProductionTuiFixture(other);
			fixture = undefined;
		}
	});
});
