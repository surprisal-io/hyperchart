import { resolveRunPaths } from "@surprisal/hyperchart/runtime";
import {
	hyperchartRunFromRunId as hyperchartRunFromRunIdWithReader,
	type HyperchartRunFromRunIdOptions,
	type SessionTranscriptReader,
} from "@surprisal/hyperchart/inspect";
import type { HyperchartRunInfo } from "@surprisal/hyperchart/host";
import { readSessionProgress } from "@surprisal/hyperchart/sessions";
import { resolve } from "node:path";
import { readSessionTranscript } from "./session_transcript.js";

export type { HyperchartRunFromRunIdOptions, SessionTranscriptReader };

/** Run inspection using the explicitly selected transcript backend. */
export function hyperchartRunFromRunId(
	runId: string,
	options: HyperchartRunFromRunIdOptions = {},
): Promise<HyperchartRunInfo> {
	return hyperchartRunFromRunIdWithReader(runId, options);
}

export function createPiFileTranscriptReader(runId: string): SessionTranscriptReader {
	const sessionsDir = resolve(resolveRunPaths(runId).runDir, "sessions");
	return async (binding) => {
		const session = Object.values(readSessionProgress(sessionsDir).sessions).find(
			(candidate) => candidate.sessionId === binding.sessionId,
		);
		return readSessionTranscript(sessionsDir, session?.sessionFile, { limit: false });
	};
}
