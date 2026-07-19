import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import staticFrames from "virtual:hyperchart-tui-stories";

export type TuiTheme = "dark" | "light";
export type TuiWidth = 60 | 80 | 120;
export type TuiComponentKind = "history" | "widget";

export type TuiTerminalPreviewProps = {
	kind: TuiComponentKind;
	width: TuiWidth;
	theme: TuiTheme;
	preset: string;
	interactive?: boolean;
};

type PreviewResponse = {
	sessionId?: string;
	lines: string[];
	action?: { kind: string; runId?: string };
};

const API_PREFIX = "/__hyperchart_tui";

function stripAnsi(value: string): string {
	return value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b_[^\u001b]*(?:\u001b\\)/g, "");
}

function staticLines(theme: TuiTheme, width: TuiWidth, kind: TuiComponentKind, preset: string): string[] {
	return staticFrames[theme][width][kind][preset] ?? staticFrames[theme][width][kind].initial ?? ["TUI preview unavailable"];
}

async function post(path: string, body: Record<string, unknown>): Promise<PreviewResponse> {
	const response = await fetch(`${API_PREFIX}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`TUI preview ${path} failed (${response.status})`);
	return (await response.json()) as PreviewResponse;
}

export function TuiTerminalPreview({
	kind,
	width,
	theme,
	preset,
	interactive = true,
}: TuiTerminalPreviewProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const sendRef = useRef<(input: string, label: string) => void>(() => undefined);
	const inputQueueRef = useRef(Promise.resolve());
	const [lines, setLines] = useState<string[]>(() => staticLines(theme, width, kind, preset));
	const [action, setAction] = useState<PreviewResponse["action"]>();
	const [mode, setMode] = useState<"loading" | "live" | "static">("loading");
	const [lastInput, setLastInput] = useState("initial");
	const [resetToken, setResetToken] = useState(0);

	useEffect(() => {
		let disposed = false;
		let createdSessionId: string | undefined;
		setLines(staticLines(theme, width, kind, preset));
		setAction(undefined);
		setLastInput("initial");
		setMode("loading");
		void post("create", { kind, width, theme, preset })
			.then((payload) => {
				createdSessionId = payload.sessionId;
				if (disposed) {
					if (createdSessionId !== undefined) void post("dispose", { sessionId: createdSessionId }).catch(() => undefined);
					return;
				}
				sessionIdRef.current = payload.sessionId ?? null;
				setLines(payload.lines);
				setAction(payload.action);
				setMode("live");
			})
			.catch(() => {
				if (!disposed) setMode("static");
			});
		return () => {
			disposed = true;
			sessionIdRef.current = null;
			if (createdSessionId !== undefined) {
				void post("dispose", { sessionId: createdSessionId }).catch(() => undefined);
			}
		};
	}, [kind, preset, resetToken, theme, width]);

	const send = (input: string, label: string) => {
		const sessionId = sessionIdRef.current;
		if (!interactive || mode !== "live" || sessionId === null || action !== undefined) return;
		inputQueueRef.current = inputQueueRef.current
			.then(async () => {
				const payload = await post("input", { sessionId, input, width });
				setLines(payload.lines);
				setAction(payload.action);
				setLastInput(label);
			})
			.catch(() => setMode("static"));
		queueMicrotask(() => terminalRef.current?.focus());
	};
	
	sendRef.current = send;

	useLayoutEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		host.replaceChildren();
		const terminal = new Terminal({
			cols: width,
			rows: kind === "widget" ? (preset === "manyRunning" ? 6 : 3) : 22,
			convertEol: true,
			cursorBlink: false,
			cursorStyle: "block",
			disableStdin: !interactive,
			fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
			fontSize: 13,
			lineHeight: 1.18,
			scrollback: 0,
			theme:
				theme === "light"
					? { background: "#f8f8f8", foreground: "#1f2328", cursor: "#5a8080", selectionBackground: "#d0d0e0" }
					: { background: "#18181e", foreground: "#d4d4d4", cursor: "#8abeb7", selectionBackground: "#3a3a4a" },
		});
		terminal.open(host);
		terminalRef.current = terminal;
		const input = terminal.onData((data) => sendRef.current(data, JSON.stringify(data)));
		if (interactive) terminal.focus();
		return () => {
			input.dispose();
			terminalRef.current = null;
			terminal.dispose();
			host.replaceChildren();
		};
	}, [interactive, kind, preset, theme, width]);

	useEffect(() => {
		const terminal = terminalRef.current;
		if (terminal === null) return;
		terminal.write(`\u001b[2J\u001b[H${lines.join("\r\n")}`);
	}, [lines, width]);

	const reset = () => setResetToken((value) => value + 1);
	const plainText = lines.map(stripAnsi).join("\n");
	const controlsDisabled = mode !== "live" || action !== undefined;

	return (
		<div className="space-y-3">
			<div role="status" className="sr-only">
				{action !== undefined
					? `TUI action: ${action.kind}${action.runId === undefined ? "" : ` ${action.runId}`}`
					: `TUI ${mode}: ${kind} · ${lastInput}`}
			</div>
			<pre className="sr-only" aria-label="TUI plain text">
				{plainText}
			</pre>
			{interactive && kind !== "widget" && (
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<fieldset disabled={controlsDisabled} className="contents disabled:opacity-50">
					<button type="button" onClick={() => send("\u001b[A", "up")} className="rounded border px-2 py-1">↑</button>
					<button type="button" onClick={() => send("\u001b[B", "down")} className="rounded border px-2 py-1">↓</button>
					<button type="button" onClick={() => send("\r", "enter")} className="rounded border px-2 py-1">Enter · open inspector</button>
					<button type="button" onClick={() => send("\u001b", "escape")} className="rounded border px-2 py-1">Esc</button>
					</fieldset>
					<button type="button" onClick={reset} disabled={mode === "loading"} className="rounded border px-2 py-1 disabled:opacity-50">Reset</button>
					<span className="text-[var(--text-muted)]">{mode === "live" ? "Live Node fixture" : mode === "loading" ? "Connecting…" : "Static build preview"}</span>
				</div>
			)}
			<div
				className="relative isolate max-w-full overflow-auto rounded-xl border border-[var(--border-primary)] p-3 shadow-lg"
				style={{ background: theme === "light" ? "#f8f8f8" : "#18181e", contain: "paint" }}
			>
				<div
					ref={hostRef}
					style={{ position: "relative", width: `${width * 8.15}px`, contain: "paint" }}
					aria-label={`${width}-column ${kind} TUI preview`}
				/>
			</div>
		</div>
	);
}
