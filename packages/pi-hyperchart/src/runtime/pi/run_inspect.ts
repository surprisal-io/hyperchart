import {
	hyperchartRunFromRunDir as hyperchartRunFromRunDirWithReader,
	type HyperchartRunFromRunDirOptions,
	type SessionTranscriptReader,
} from "@surprisal/hyperchart/inspect";
import type { HyperchartRunInfo } from "@surprisal/hyperchart/host";
import { readSessionProgress } from "@surprisal/hyperchart/sessions";
import { resolve } from "node:path";
import { readSessionTranscript } from "./session_transcript.js";

export type { HyperchartRunFromRunDirOptions, SessionTranscriptReader };

/** Run inspection using the explicitly selected transcript backend. */
export function hyperchartRunFromRunDir(
	runDir: string,
	options: HyperchartRunFromRunDirOptions = {},
): Promise<HyperchartRunInfo> {
	return hyperchartRunFromRunDirWithReader(runDir, options);
}

export function createPiFileTranscriptReader(runDir: string): SessionTranscriptReader {
	const sessionsDir = resolve(runDir, "sessions");
	return async (binding) => {
		const session = Object.values(readSessionProgress(sessionsDir).sessions).find(
			(candidate) => candidate.sessionId === binding.sessionId,
		);
		return readSessionTranscript(sessionsDir, session?.sessionFile, { limit: false });
	};
}
