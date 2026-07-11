export const HYPERCHART_COMMAND_EVENT = "hyperchart:command";

export interface HyperchartCommandRequest {
	args: string;
	claim(run: () => void | Promise<void>): boolean;
}

export interface HyperchartCommandEventBus {
	emit(event: string, payload: unknown): void;
}

/**
 * Request command execution from the loaded pi-hyperchart extension.
 * Listeners must claim synchronously; command work may remain asynchronous.
 */
export async function requestHyperchartCommand(
	events: HyperchartCommandEventBus,
	args: string,
): Promise<boolean> {
	let claimed = false;
	let completion: Promise<void> | undefined;
	const request: HyperchartCommandRequest = {
		args,
		claim(run) {
			if (claimed) return false;
			claimed = true;
			completion = Promise.resolve().then(run);
			return true;
		},
	};

	events.emit(HYPERCHART_COMMAND_EVENT, request);
	if (!claimed) return false;
	await completion;
	return true;
}
