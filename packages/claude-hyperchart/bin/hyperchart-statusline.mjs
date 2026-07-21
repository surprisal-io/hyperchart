#!/usr/bin/env node
// Claude Code statusline for Hyperchart runs.
//
// Prints one line summarizing live runs (chart, active agent states, progress)
// and recently finished ones. Wire it into settings.json:
//
//   "statusLine": {
//     "type": "command",
//     "command": "node ~/.claude/marketplaces/surprisal-local/hyperchart/bin/hyperchart-statusline.mjs"
//   }
//
// Reads runs from $HYPERCHART_RUNS_ROOT, falling back to
// ${CLAUDE_CONFIG_DIR:-~/.claude}/hypercharts/runs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RECENT_TERMINAL_MS = 5 * 60 * 1000;
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const runsRoot = process.env.HYPERCHART_RUNS_ROOT ?? join(configDir, "hypercharts", "runs");

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function pidAlive(pid) {
	if (typeof pid !== "number") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// "research.initial-research.landscape.scout" -> "landscape.scout"
function shortState(session) {
	const state = session.actionUid?.state ?? session.actionName ?? "?";
	const label = String(state).split(".").slice(-2).join(".");
	return label.length > 34 ? `${label.slice(0, 33)}…` : label;
}

function liveLabel(runDir, status) {
	const progress = readJson(join(runDir, "sessions", "progress.json"));
	const sessions = progress === undefined ? [] : Object.values(progress.sessions ?? {});
	const active = sessions.filter((s) => s.status === "running" || s.status === "starting");
	const done = sessions.filter((s) => s.status === "completed").length;
	const names = active.map(shortState);
	const shown = names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "");
	const detail = active.length > 0 ? shown : "scripts";
	return `${YELLOW}⚡${RESET} ${status.chartId}: ${detail} ${DIM}[${active.length} live/${done} done]${RESET}`;
}

function terminalLabel(status) {
	const mark = status.state === "complete" ? `${GREEN}✓${RESET}` : status.state === "failed" ? `${RED}✗${RESET}` : `${DIM}■${RESET}`;
	return `${mark} ${status.chartId}: ${status.state}`;
}

let entries = [];
try {
	entries = readdirSync(runsRoot);
} catch {
	// no runs directory yet
}

const live = [];
const recent = [];
for (const name of entries) {
	const dir = join(runsRoot, name);
	const statusPath = join(dir, "status.json");
	const status = readJson(statusPath);
	if (status === undefined || typeof status.chartId !== "string") continue;
	const isLiveState = status.state === "starting" || status.state === "running" || status.state === "stopping";
	if (isLiveState && pidAlive(status.pid)) {
		live.push(liveLabel(dir, status));
	} else if (!isLiveState) {
		let mtime = 0;
		try {
			mtime = statSync(statusPath).mtimeMs;
		} catch {}
		if (Date.now() - mtime < RECENT_TERMINAL_MS) recent.push(terminalLabel(status));
	}
}

const parts = [...live, ...recent];
process.stdout.write(parts.length > 0 ? parts.join("  |  ") : `${DIM}hyperchart: idle${RESET}`);
