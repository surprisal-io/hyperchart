#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { emitPendingClaudeNotifications } from "../dist/monitor.js";

const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const options = {
	runsRoot: process.env.HYPERCHART_RUNS_ROOT ?? join(configDir, "hypercharts", "runs"),
	cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
	sessionId: process.env.CLAUDE_CODE_SESSION_ID,
};
const intervalMs = positiveInteger(process.env.HYPERCHART_MONITOR_INTERVAL_MS) ?? 1_000;

function scan() {
	try {
		emitPendingClaudeNotifications(options);
	} catch (error) {
		// stdout is reserved for one-line Claude monitor notifications.
		process.stderr.write(`[hyperchart-monitor] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	}
}

scan();
setInterval(scan, intervalMs);

function positiveInteger(value) {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
