import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { Theme, initTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	RunHistoryOverlay,
	RunWidget,
	type RunHistoryAction,
} from "../packages/pi-hyperchart/src/tui/components.js";
import {
	cleanupProductionTuiFixture,
	materializeProductionTuiFixture,
	type ProductionTuiFixture,
} from "./tui-production-fixture.js";

const VIRTUAL_ID = "virtual:hyperchart-tui-stories";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;
const API_PREFIX = "/__hyperchart_tui";
const WIDTHS = [60, 80, 120] as const;
const THEMES = ["dark", "light"] as const;

type ComponentKind = "history" | "widget";
type ThemeName = (typeof THEMES)[number];
type PreviewAction = RunHistoryAction | { kind: "close" };
type PreviewComponent = Component & { dispose?: () => void };
type PreviewSession = { component: PreviewComponent; action?: PreviewAction };

let productionFixture: ProductionTuiFixture | undefined;

function fixture(): ProductionTuiFixture {
	productionFixture ??= materializeProductionTuiFixture();
	return productionFixture;
}

type ThemeJson = {
	vars: Record<string, string | number>;
	colors: Record<string, string | number>;
};

const bgKeys = new Set([
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
]);

function loadPiTheme(name: ThemeName): Theme {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const jsonPath = resolve(dirname(entry), "modes/interactive/theme", `${name}.json`);
	const source = JSON.parse(readFileSync(jsonPath, "utf8")) as ThemeJson;
	const resolved = Object.fromEntries(
		Object.entries(source.colors).map(([key, value]) => [
			key,
			typeof value === "string" && !value.startsWith("#") && value !== "" ? (source.vars[value] ?? value) : value,
		]),
	);
	return new Theme(
		Object.fromEntries(Object.entries(resolved).filter(([key]) => !bgKeys.has(key))) as ConstructorParameters<
			typeof Theme
		>[0],
		Object.fromEntries(Object.entries(resolved).filter(([key]) => bgKeys.has(key))) as ConstructorParameters<
			typeof Theme
		>[1],
		"truecolor",
		{ name },
	);
}

function fakeTui(width: number): TUI {
	return {
		requestRender() {},
		terminal: { columns: width, rows: 40 },
	} as unknown as TUI;
}

const presetInputs: Record<ComponentKind, Record<string, string[]>> = {
	history: {
		initial: [],
		stopped: ["\u001b[B"],
		stoppedWithWarning: ["\u001b[B", "\u001b[B"],
	},
	widget: { initial: [], manyRunning: [] },
};

async function waitForData(component: PreviewComponent, width: number): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (!component.render(width).join("\n").includes("loading")) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	}
}

async function createComponent(kind: ComponentKind, themeName: ThemeName, width: number, preset: string): Promise<PreviewSession> {
	initTheme(themeName, false);
	const theme = loadPiTheme(themeName);
	const tui = fakeTui(width);
	const data = fixture();
	const session: PreviewSession = { component: undefined as unknown as PreviewComponent };
	if (kind === "history") {
		session.component = new RunHistoryOverlay(tui, theme, {
			cwd: data.primary.cwd ?? "/Users/demo/Work/pi-hyperchart",
			items: data.history,
			done: (action) => {
				session.action = action;
			},
		});
	} else {
		session.component = new RunWidget(tui, theme, preset === "manyRunning" ? data.manyRunning : data.primary);
	}
	await waitForData(session.component, width);
	return session;
}

async function createWithPreset(kind: ComponentKind, theme: ThemeName, width: number, preset: string) {
	const session = await createComponent(kind, theme, width, preset);
	for (const input of presetInputs[kind][preset] ?? []) {
		session.component.handleInput?.(input);
		await waitForData(session.component, width);
	}
	return session;
}

function responsePayload(session: PreviewSession, width: number) {
	return {
		lines:
			session.action === undefined
				? session.component.render(width)
				: [
						"Hyperchart TUI action",
						`action: ${session.action.kind}${"runId" in session.action ? ` · ${session.action.runId}` : ""}`,
					],
		...(session.action === undefined ? {} : { action: session.action }),
	};
}

async function staticFrames() {
	const output: Record<string, unknown> = {};
	for (const theme of THEMES) {
		const byWidth: Record<string, unknown> = {};
		for (const width of WIDTHS) {
			const byComponent: Record<string, unknown> = {};
			for (const kind of ["history", "widget"] as const) {
				const byPreset: Record<string, string[]> = {};
				for (const preset of Object.keys(presetInputs[kind])) {
					const session = await createWithPreset(kind, theme, width, preset);
					byPreset[preset] = responsePayload(session, width).lines;
					session.component.dispose?.();
				}
				byComponent[kind] = byPreset;
			}
			byWidth[width] = byComponent;
		}
		output[theme] = byWidth;
	}
	return output;
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolvePromise, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			try {
				resolvePromise(body.length === 0 ? {} : (JSON.parse(body) as Record<string, unknown>));
			} catch (error) {
				reject(error);
			}
		});
	});
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json");
	response.end(JSON.stringify(value));
}

export function tuiPreviewPlugin(): Plugin {
	const sessions = new Map<string, PreviewSession>();
	let nextSessionId = 1;
	const disposeAll = () => {
		for (const session of sessions.values()) session.component.dispose?.();
		sessions.clear();
		cleanupProductionTuiFixture(productionFixture);
		productionFixture = undefined;
	};
	return {
		name: "hyperchart-tui-story-frames",
		resolveId(id) {
			return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : undefined;
		},
		async load(id) {
			if (id !== RESOLVED_VIRTUAL_ID) return undefined;
			return `export default ${JSON.stringify(await staticFrames())};`;
		},
		configureServer(server) {
			server.httpServer?.once("close", disposeAll);
			server.middlewares.use(async (request, response, next) => {
				if (request.url?.startsWith(API_PREFIX) !== true) return next();
				try {
					const body = await readBody(request);
					if (request.url === `${API_PREFIX}/create`) {
						const kind = body.kind as ComponentKind;
						const theme = body.theme as ThemeName;
						const width = Number(body.width);
						const preset = typeof body.preset === "string" ? body.preset : "initial";
						if (
							!(["history", "widget"] as string[]).includes(kind) ||
							!THEMES.includes(theme) ||
							!WIDTHS.includes(width as (typeof WIDTHS)[number])
						) {
							return sendJson(response, 400, { error: "Invalid TUI preview options" });
						}
						const session = await createWithPreset(kind, theme, width, preset);
						const sessionId = String(nextSessionId++);
						if (sessions.size >= 50) {
							const oldestId = sessions.keys().next().value as string | undefined;
							if (oldestId !== undefined) {
								sessions.get(oldestId)?.component.dispose?.();
								sessions.delete(oldestId);
							}
						}
						sessions.set(sessionId, session);
						return sendJson(response, 200, { sessionId, ...responsePayload(session, width) });
					}
					const sessionId = String(body.sessionId ?? "");
					const session = sessions.get(sessionId);
					if (session === undefined) return sendJson(response, 404, { error: "Unknown TUI preview session" });
					if (request.url === `${API_PREFIX}/input`) {
						const input = typeof body.input === "string" ? body.input : "";
						const width = Number(body.width);
						session.component.handleInput?.(input);
						await waitForData(session.component, width);
						return sendJson(response, 200, responsePayload(session, width));
					}
					if (request.url === `${API_PREFIX}/render`) {
						return sendJson(response, 200, responsePayload(session, Number(body.width)));
					}
					if (request.url === `${API_PREFIX}/dispose`) {
						session.component.dispose?.();
						sessions.delete(sessionId);
						return sendJson(response, 200, { ok: true });
					}
					return sendJson(response, 404, { error: "Unknown TUI preview endpoint" });
				} catch (error) {
					return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			});
		},
		closeBundle() {
			disposeAll();
		},
	};
}
