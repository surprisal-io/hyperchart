import { dirname } from "node:path";
import { promises as fsp } from "node:fs";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import type { DurableLogRecord } from "../../index.js";

export interface LogStore {
	append(records: readonly DurableLogRecord[]): void;
	readAll(): Promise<readonly DurableLogRecord[]>;
}

export class JsonlLogStore implements LogStore {
	constructor(
		readonly filePath: string,
		private readonly onWarn: (message: string) => void = () => {},
	) {}

	append(records: readonly DurableLogRecord[]): void {
		if (records.length === 0) return;
		mkdirSync(dirname(this.filePath), { recursive: true });
		appendFileSync(this.filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	}

	async readAll(): Promise<readonly DurableLogRecord[]> {
		if (!existsSync(this.filePath)) return [];
		const content = await fsp.readFile(this.filePath, "utf8");
		if (content.length === 0) return [];

		const lines = content.split(/\r?\n/);
		if (content.endsWith("\n") || content.endsWith("\r\n")) {
			lines.pop();
		}

		const records: DurableLogRecord[] = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			if (line === undefined || line.length === 0) continue;
			try {
				records.push(JSON.parse(line) as DurableLogRecord);
			} catch (error) {
				if (index === lines.length - 1) {
					this.onWarn(`Ignoring incomplete trailing JSONL record in ${this.filePath}`);
					break;
				}
				throw new Error(
					`Failed to parse durable log ${this.filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return records;
	}
}

export class MemoryLogStore implements LogStore {
	private readonly records: DurableLogRecord[] = [];

	constructor(records: readonly DurableLogRecord[] = []) {
		this.records.push(...records);
	}

	append(records: readonly DurableLogRecord[]): void {
		this.records.push(...records);
	}

	async readAll(): Promise<readonly DurableLogRecord[]> {
		return [...this.records];
	}
}
