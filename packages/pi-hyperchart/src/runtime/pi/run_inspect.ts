import {
	hyperchartRunFromRunDir as hyperchartRunFromRunDirWithReader,
	type HyperchartRunFromRunDirOptions,
} from "@surprisal/hyperchart/inspect";
import type { HyperchartRunInfo } from "@surprisal/hyperchart/host";
import { readSessionTranscript } from "./session_transcript.js";

export type { HyperchartRunFromRunDirOptions };

/** Run inspection with the Pi session-transcript format bound as the default reader. */
export function hyperchartRunFromRunDir(
	runDir: string,
	options: HyperchartRunFromRunDirOptions = {},
): Promise<HyperchartRunInfo> {
	return hyperchartRunFromRunDirWithReader(runDir, { readTranscript: readSessionTranscript, ...options });
}
