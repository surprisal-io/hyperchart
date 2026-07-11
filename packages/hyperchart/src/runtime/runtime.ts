import { ChartAst, DurableLogRecord, Effect, MachineEvent } from "../index.js";

export interface Runtime {
	runEffects(effects: Effect[]): void;
	eventsQueue(): AsyncIterable<MachineEvent>;
	loadAst(): Promise<ChartAst>;
	loadLogs(): Promise<readonly DurableLogRecord[]>;
}
