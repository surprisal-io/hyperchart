import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HyperchartSessionMessageInfo } from "@surprisal/hyperchart/host";
import type { NeutralTranscriptHeader } from "@surprisal/hyperchart/inspect";

export type NeutralTranscriptWriter = {
	path: string;
	append(record: HyperchartSessionMessageInfo): void;
};

/**
 * Appends display transcript records in the neutral JSONL format that run
 * inspection reads by default: a header line followed by one pre-flattened
 * HyperchartSessionMessageInfo per line.
 */
export function createNeutralTranscriptWriter(path: string, sessionId: string): NeutralTranscriptWriter {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		// A resumed session appends to its existing transcript; the header is written once.
		const header: NeutralTranscriptHeader = { hyperchartTranscript: 1, sessionId, createdAt: Date.now() };
		appendFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
	}
	return {
		path,
		append(record) {
			appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
		},
	};
}
