import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { HyperchartRunnerConfig } from "@surprisal/hyperchart/runtime";
import {
	isRunLive,
	isTerminalRunState,
	patchRunStatus,
	readRunStatus,
	type HyperchartRunStatus,
} from "@surprisal/hyperchart/sessions";

function runnerEntry(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		// Source module (jiti/tests): src/mcp -> src/claude. Built module: dist/mcp -> src/claude (the
		// .mjs shim ships in the tarball's src tree and loads TypeScript through jiti).
		resolve(moduleDir, "../claude/hyperchart_runner.mjs"),
		resolve(moduleDir, "../../src/claude/hyperchart_runner.mjs"),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found === undefined) throw new Error(`Claude hyperchart runner shim not found near ${moduleDir}`);
	return found;
}

/** Spawns the detached runner process for a prepared run directory and returns its pid. */
export function spawnDetachedRunner(config: HyperchartRunnerConfig): number {
	const configPath = resolve(config.runDir, "runner.config.json");
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	const stdoutFd = openSync(resolve(config.runDir, "runner.stdout.log"), "a");
	const stderrFd = openSync(resolve(config.runDir, "runner.stderr.log"), "a");
	try {
		const child = spawn(process.execPath, [runnerEntry(), configPath], {
			cwd: config.workDir,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
			env: process.env,
		});
		child.unref();
		if (child.pid === undefined) throw new Error("hyperchart runner did not produce a pid");
		return child.pid;
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}
}

/** Resolves when the run reaches a terminal status; marks it failed if the heartbeat is lost. */
export function watchRun(runDir: string): Promise<HyperchartRunStatus> {
	return new Promise((resolveDone) => {
		const timer = setInterval(() => {
			const status = readRunStatus(runDir);
			if (status === undefined) return;
			if (isTerminalRunState(status.state)) {
				clearInterval(timer);
				resolveDone(status);
				return;
			}
			if (!isRunLive(status) && Date.now() - status.updatedAt > 20_000) {
				const failed = patchRunStatus(runDir, {
					state: "failed",
					error: "runner heartbeat lost",
					exitCode: 1,
				});
				clearInterval(timer);
				resolveDone(failed);
			}
		}, 1_000);
		timer.unref();
	});
}
