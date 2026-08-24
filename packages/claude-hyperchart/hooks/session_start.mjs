// SessionStart recovery: surface only this exact Claude session's live runs and
// the shared arbiter's one pinned unanswered user gate.
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	acquireActiveUserInteraction,
	claimUserInteractionReceipt,
	markUserInteractionReceipt,
} from "@surprisal/hyperchart/runtime";

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function canonicalPath(path) {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
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

function gateContext(interaction) {
	const request = interaction.request;
	const allowed = request.events.filter((event) => event !== "FAILED");
	return [
		`ACTIVE HYPERCHART USER GATE (${request.runId}, ${request.seqId})`,
		`Question: ${request.prompt}`,
		request.options.length === 0
			? "Free text: use AskUserQuestion with an appropriate free-text/Other path and preserve the user's real answer."
			: `Map these authored options to AskUserQuestion choices: ${request.options.join(", ")}.`,
		`Allowed response events: ${allowed.join(", ")}.`,
		request.reply === undefined ? undefined : `Reply contract: ${JSON.stringify(request.reply)}.`,
		"Finish the current safe action and start no unrelated work. This is session recovery: if no AskUserQuestion is still in flight, invoke it again for this pinned gate; never open concurrent duplicates or infer, fabricate, or supply the answer yourself.",
		`Immediately commit the human result with hyperchart_respond using runId=${JSON.stringify(request.runId)}, seqId=${request.seqId}, an allowed event, and output when required. Do not continue before commit.`,
		"This is at-least-once recovery of the same pinned gate; repeated context is not a second question and must not select a queued gate.",
	].filter((line) => line !== undefined).join("\n");
}

async function writeStdout(line) {
	await new Promise((resolveWrite, rejectWrite) => {
		process.stdout.write(line, (error) => error ? rejectWrite(error) : resolveWrite());
	});
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
	const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
	const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	const runsRoot = process.env.HYPERCHART_RUNS_ROOT ?? join(configDir, "hypercharts", "runs");
	if (!existsSync(runsRoot)) return;
	const now = Date.now();
	const lines = [];
	let active;
	if (sessionId !== undefined) {
		const owner = { runsRoot, host: "claude", sessionId, workDir: cwd };
		active = await acquireActiveUserInteraction(owner);
		if (active?.presentation === "pending") {
			claimUserInteractionReceipt(active.runDir, active.request.branchId, active.request.seqId, "claude", sessionId, { source: "session-start" });
		}
		// Re-arbitrate after claiming so a concurrent lower coordinate cannot also be
		// presented by the monitor/wait path.
		active = await acquireActiveUserInteraction(owner);
		if (active !== undefined) lines.push(gateContext(active));
	}
	const liveLines = [];
	for (const entry of readdirSync(runsRoot)) {
		const runDir = join(runsRoot, entry);
		const meta = readJson(join(runDir, "meta.json"));
		if (
			meta === undefined ||
			typeof meta.workDir !== "string" ||
			canonicalPath(meta.workDir) !== canonicalPath(cwd) ||
			sessionId === undefined ||
			meta.originSessionId !== sessionId
		) continue;
		const status = readJson(join(runDir, "status.json"));
		if (!isLive(status, now)) continue;
		liveLines.push(`- ${entry} (chart ${status.chartId ?? meta.chartId}, ${status.state}, dir ${runDir})`);
	}
	if (liveLines.length > 0) {
		lines.push([
			"Live Hyperchart runs for this exact Claude session and directory (inspect with hyperchart_run_inspect, watch with hyperchart_view):",
			...liveLines,
		].join("\n"));
	}
	if (lines.length === 0) return;
	const context = lines.join("\n\n");
	await writeStdout(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`);
	// Confirm only after the hook output write succeeds. If the process dies first, the
	// same pinned gate remains recoverable by the monitor or another SessionStart.
	if (active !== undefined && sessionId !== undefined) {
		try {
			markUserInteractionReceipt(active.runDir, active.request.branchId, active.request.seqId, "claude", sessionId);
		} catch {
			// A concurrent machine close/response won after context was constructed.
		}
	}
}

await main();
