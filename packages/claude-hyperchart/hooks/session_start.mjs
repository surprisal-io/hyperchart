// SessionStart hook: surface this directory's live Hyperchart runs as context.
// Deliberately dependency-free: reads meta.json/status.json with plain JSON
// parsing so the hook works regardless of install layout.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isLive(status, now) {
	if (status === undefined) return false;
	if (["complete", "failed", "stopped", "stopping"].includes(status.state)) return false;
	if (typeof status.pid === "number" && isPidAlive(status.pid)) return true;
	return typeof status.heartbeatAt === "number" && now - status.heartbeatAt < 15_000;
}

async function main() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const input = (() => {
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return {};
		}
	})();
	const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
	const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	const runsRoot = process.env.HYPERCHART_RUNS_ROOT ?? join(configDir, "hypercharts", "runs");
	if (!existsSync(runsRoot)) return;
	const now = Date.now();
	const lines = [];
	for (const entry of readdirSync(runsRoot)) {
		const runDir = join(runsRoot, entry);
		const meta = readJson(join(runDir, "meta.json"));
		if (meta === undefined || typeof meta.workDir !== "string" || resolve(meta.workDir) !== resolve(cwd)) continue;
		const status = readJson(join(runDir, "status.json"));
		if (!isLive(status, now)) continue;
		lines.push(`- ${entry} (chart ${status.chartId ?? meta.chartId}, ${status.state}, dir ${runDir})`);
	}
	if (lines.length === 0) return;
	const context = [
		"Live Hyperchart runs for this directory (inspect with hyperchart_run_inspect, watch with hyperchart_view):",
		...lines,
	].join("\n");
	process.stdout.write(
		`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`,
	);
}

await main();
