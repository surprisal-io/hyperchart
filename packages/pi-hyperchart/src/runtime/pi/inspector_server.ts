import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { HyperchartRunInfo } from "@surprisal/hyperchart/host";

export type RunInspectorSource = {
	runId: string;
	loadRun: () => Promise<HyperchartRunInfo>;
};

export type OpenRunInspectorOptions = RunInspectorSource & {
	openBrowser?: (url: string) => void | Promise<void>;
};

type InspectorEntry = RunInspectorSource & { touchedAt: number };
type InspectorServerState = {
	server: Server;
	origin: string;
	entries: Map<string, InspectorEntry>;
};

const MAX_INSPECTOR_ENTRIES = 32;
let singleton: Promise<InspectorServerState> | undefined;

/** Register a run with the process-wide localhost inspector and open its unique URL. */
export async function openRunInspector(options: OpenRunInspectorOptions): Promise<{ url: string }> {
	const state = await getInspectorServer();
	const token = randomBytes(18).toString("base64url");
	state.entries.set(token, { runId: options.runId, loadRun: options.loadRun, touchedAt: Date.now() });
	trimEntries(state.entries);
	const url = `${state.origin}/runs/${token}`;
	await (options.openBrowser ?? openSystemBrowser)(url);
	return { url };
}

/** Test/process cleanup hook. Normal Pi sessions rely on process shutdown. */
export async function closeRunInspectorServer(): Promise<void> {
	const pending = singleton;
	singleton = undefined;
	if (pending === undefined) return;
	const state = await pending;
	state.entries.clear();
	await new Promise<void>((resolveClose, reject) => {
		state.server.close((error) => (error === undefined ? resolveClose() : reject(error)));
		// close() alone waits for browser keep-alive sockets; drop them so shutdown cannot hang.
		state.server.closeAllConnections();
	});
}

async function getInspectorServer(): Promise<InspectorServerState> {
	singleton ??= startInspectorServer().catch((error) => {
		singleton = undefined;
		throw error;
	});
	return singleton;
}

async function startInspectorServer(): Promise<InspectorServerState> {
	const entries = new Map<string, InspectorEntry>();
	const server = createServer((request, response) => void routeRequest(entries, request, response));
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolveListen();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Inspector server did not bind a TCP port");
	server.unref();
	return { server, origin: `http://127.0.0.1:${address.port}`, entries };
}

async function routeRequest(
	entries: Map<string, InspectorEntry>,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		setSecurityHeaders(response);
		if (request.method !== "GET") return sendText(response, 405, "Method not allowed");

		const apiToken = routeToken(url.pathname, "/api/runs/");
		if (apiToken !== undefined) {
			const entry = entries.get(apiToken);
			if (entry === undefined) return sendJson(response, 404, { error: "Inspector run not found or expired" });
			entry.touchedAt = Date.now();
			try {
				return sendJson(response, 200, { run: await entry.loadRun() });
			} catch (error) {
				return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		const pageToken = routeToken(url.pathname, "/runs/");
		if (pageToken !== undefined) {
			if (!entries.has(pageToken)) return sendText(response, 404, "Inspector run not found or expired");
			return sendHtml(response, inspectorHtml());
		}
		if (url.pathname === "/assets/client.js") return sendAsset(response, "client.js", "text/javascript; charset=utf-8");
		if (url.pathname === "/assets/styles.css") return sendAsset(response, "styles.css", "text/css; charset=utf-8");
		return sendText(response, 404, "Not found");
	} catch (error) {
		return sendText(response, 500, error instanceof Error ? error.message : String(error));
	}
}

function routeToken(pathname: string, prefix: string): string | undefined {
	if (!pathname.startsWith(prefix)) return undefined;
	const token = pathname.slice(prefix.length);
	return /^[A-Za-z0-9_-]+$/.test(token) ? token : undefined;
}

function inspectorHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hyperchart Inspector</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body><div id="root"></div><script type="module" src="/assets/client.js"></script></body>
</html>`;
}

function sendAsset(response: ServerResponse, fileName: "client.js" | "styles.css", contentType: string): void {
	const path = resolveInspectorAsset(fileName);
	if (path === undefined) {
		return sendText(response, 503, "Inspector browser assets are missing. Rebuild @surprisal/pi-hyperchart.");
	}
	response.statusCode = 200;
	response.setHeader("Content-Type", contentType);
	response.setHeader("Cache-Control", "no-cache");
	createReadStream(path).pipe(response);
}

function resolveInspectorAsset(fileName: string): string | undefined {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(moduleDir, "../../inspector-web", fileName),
		resolve(moduleDir, "../../../dist/inspector-web", fileName),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

function setSecurityHeaders(response: ServerResponse): void {
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("Cache-Control", "no-store");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:",
	);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, value: string): void {
	response.statusCode = 200;
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.end(value);
}

function sendText(response: ServerResponse, status: number, value: string): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "text/plain; charset=utf-8");
	response.end(value);
}

function trimEntries(entries: Map<string, InspectorEntry>): void {
	if (entries.size <= MAX_INSPECTOR_ENTRIES) return;
	const oldest = [...entries.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt);
	for (const [token] of oldest.slice(0, entries.size - MAX_INSPECTOR_ENTRIES)) entries.delete(token);
}

function openSystemBrowser(url: string): Promise<void> {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	return new Promise((resolveOpen, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolveOpen();
		});
	});
}
