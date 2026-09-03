import { isAbsolute, relative, resolve, sep } from "node:path";
import { renderJoin, renderRead, renderTemplate, type MachineState } from "../core/machine.js";
import { nodeAt } from "../core/paths.js";
import type { BranchId } from "../core/durable_events.js";
import type { TerminalNotificationPayload } from "../runtime/generic/terminal_notifications.js";
import type { RunTerminalState } from "./run_outcome.js";

export function renderTerminalNotificationPayload(
	state: MachineState,
	input: { runId: string; branchId: BranchId; runDir: string; workDir: string; outcome: RunTerminalState; error?: string },
): TerminalNotificationPayload {
	const standard = input.outcome === "failed"
		? `Hyperchart run ${input.runId} (${state.ast.id}) failed${input.error === undefined ? "" : `: ${input.error}`}. Inspect the durable run at ${input.runDir}.`
		: `Hyperchart run ${input.runId} (${state.ast.id}) completed successfully. Inspect the durable run at ${input.runDir}.`;
	const custom: string[] = [];
	const artifactPaths: string[] = [];
	for (const leaf of state.projection.activeLeaves) {
		const terminal = nodeAt(state.ast, leaf);
		if (terminal?.kind !== "final" || terminal.notify === undefined) continue;
		const scope = terminal.notify.scope ?? leaf;
		if (terminal.notify.prompt !== undefined) custom.push(renderTemplate(state, terminal.notify.prompt, scope));
		for (const read of terminal.notify.artifacts ?? []) {
			const rendered = read.kind === "joinArtifactOf" ? renderJoin(state, read, scope) : [renderRead(state, read, scope)];
			for (const artifact of rendered) artifactPaths.push(authoritativeArtifactPath(input.workDir, artifact.path));
		}
	}
	const artifacts = [...new Set(artifactPaths)];
	const sections = [standard, ...custom];
	if (artifacts.length > 0) sections.push(`Declared artifacts (authoritative paths; contents not inlined):\n${artifacts.map((path) => `- ${path}`).join("\n")}`);
	return {
		runId: input.runId,
		branchId: input.branchId,
		runDir: resolve(input.runDir),
		chartId: state.ast.id,
		outcome: input.outcome,
		prompt: sections.join("\n\n"),
		artifacts,
		...(input.error === undefined ? {} : { error: input.error }),
	};
}

function authoritativeArtifactPath(workDir: string, authoredPath: string): string {
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(authoredPath)) throw new Error(`Terminal artifact '${authoredPath}' is not a local path`);
	const root = resolve(workDir);
	const path = resolve(root, authoredPath);
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Terminal artifact '${authoredPath}' escapes workDir ${root}`);
	return path;
}
