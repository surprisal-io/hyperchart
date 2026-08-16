import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	RunHistoryOverlay,
	type RunHistoryAction,
	RunWidget,
	type RunHistoryItem,
} from "../packages/pi-hyperchart/src/tui/components.js";

beforeAll(() => initTheme("dark", false));

const items: RunHistoryItem[] = [
	{
		runId: "first-run",
		branchId: "main",		runDir: "/tmp/first-run",
		chartId: "demo",
		state: "running",
		live: true,
		final: false,
		sessionCount: 1,
		createdAt: "now",
		updatedAt: "now",
	},
	{
		runId: "second-run",
		branchId: "main",		runDir: "/tmp/second-run",
		chartId: "demo",
		state: "complete",
		live: false,
		final: true,
		sessionCount: 2,
		createdAt: "earlier",
		updatedAt: "now",
	},
];

function fakeTui(): TUI {
	return { requestRender() {} } as unknown as TUI;
}

const testTheme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

describe("minimal Hyperchart TUI", () => {
	it("uses history only as a browser-inspector picker", () => {
		const actions: RunHistoryAction[] = [];
		const picker = new RunHistoryOverlay(fakeTui(), testTheme, {
			cwd: "/work/demo",
			items,
			done: (action) => actions.push(action),
		});

		for (const removedAction of ["e", "r", "s", "d", "v", "\u001b[C", "?"]) {
			picker.handleInput(removedAction);
		}
		expect(actions).toEqual([]);
		expect(picker.render(100).join("\n")).toContain("Enter open browser inspector");

		picker.handleInput("\u001b[B");
		picker.handleInput("\r");
		expect(actions).toEqual([{ kind: "view", runId: "second-run" }]);
	});

	it("renders refresh failures instead of leaking an unhandled rejection", async () => {
		const widget = new RunWidget(fakeTui(), testTheme, {
			runId: "broken-run",
			branchId: "main",			runDir: "/definitely-missing-hyperchart-run",
			logPath: "/definitely-missing-hyperchart-run/log.jsonl",
			ast: {} as never,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(widget.render(120).join("\n")).toContain("inspect failed");
		widget.dispose();
	});

	it("closes the picker with Escape", () => {
		const actions: RunHistoryAction[] = [];
		const picker = new RunHistoryOverlay(fakeTui(), testTheme, {
			cwd: "/work/demo",
			items,
			done: (action) => actions.push(action),
		});
		picker.handleInput("\u001b");
		expect(actions).toEqual([{ kind: "close" }]);
	});
});
