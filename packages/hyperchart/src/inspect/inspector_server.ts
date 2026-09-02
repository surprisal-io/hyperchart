import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { HyperchartInspectorDataSource, HyperchartRunInfo } from "../host/index.js";

export type RunInspectorSource = {
	runId: string;
	/** Initial non-durable branch view registered for this inspector source. */
	branchId?: string;
	loadRun: (branchId?: string) => Promise<HyperchartRunInfo>;
	historyDataSource?: HyperchartInspectorDataSource;
	steerSession?: (branchId: string, actionKey: string, message: string) => void | Promise<void>;
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
	state.entries.set(token, {
		runId: options.runId,
		loadRun: options.loadRun,
		...(options.historyDataSource === undefined ? {} : { historyDataSource: options.historyDataSource }),
		...(options.steerSession === undefined ? {} : { steerSession: options.steerSession }),
		touchedAt: Date.now(),
	});
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
	const host = inspectorHost();
	const server = createServer((request, response) => void routeRequest(entries, request, response));
	const fixedPort = inspectorPort();
	try {
		await listenOnce(server, fixedPort, host);
	} catch (error) {
		// A fixed port serves one process; parallel sessions fall back to an
		// ephemeral port so every inspector still hands out a working URL.
		if (fixedPort === 0 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		await listenOnce(server, 0, host);
	}
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Inspector server did not bind a TCP port");
	server.unref();
	return { server, origin: `http://${inspectorUrlHost(host)}:${address.port}`, entries };
}

function listenOnce(server: Server, port: number, host: string): Promise<void> {
	return new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolveListen();
		});
	});
}

/**
 * Bind host for the inspector. The default is loopback-only; binding a
 * non-loopback host (e.g. 0.0.0.0 for LAN access) is an explicit opt-in — the
 * unguessable per-run URL token is then the only access control, so use it on
 * trusted networks only.
 */
function inspectorHost(): string {
	const raw = process.env.HYPERCHART_INSPECTOR_HOST?.trim();
	return raw === undefined || raw.length === 0 ? "127.0.0.1" : raw;
}

/** The host to advertise in inspector URLs; wildcard binds resolve to the machine's LAN address. */
function inspectorUrlHost(bindHost: string): string {
	if (bindHost !== "0.0.0.0" && bindHost !== "::") return bindHost;
	for (const interfaces of Object.values(networkInterfaces())) {
		for (const entry of interfaces ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return "127.0.0.1";
}

async function routeRequest(
	entries: Map<string, InspectorEntry>,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		setSecurityHeaders(response);

		const historyToken = routeToken(url.pathname, "/api/runs/", "/history");
		if (historyToken !== undefined) {
			if (request.method !== "POST") return sendText(response, 405, "Method not allowed");
			const entry = entries.get(historyToken);
			if (entry === undefined) return sendJson(response, 404, { error: "Inspector run not found or expired" });
			if (entry.historyDataSource === undefined) return sendJson(response, 409, { error: "Lazy history is unavailable for this run" });
			entry.touchedAt = Date.now();
			try {
				const body = await readJsonBody(request);
				const input = typeof body.input === "object" && body.input !== null && !Array.isArray(body.input) ? body.input as Record<string, unknown> : {};
				const requestInput = { ...input, runId: entry.runId } as never;
				let result: unknown;
				switch (body.operation) {
					case "listBranches": result = await entry.historyDataSource.listBranches(requestInput); break;
					case "readStateVisits": result = await entry.historyDataSource.readStateVisits(requestInput); break;
					case "readMapVisits": result = await entry.historyDataSource.readMapVisits(requestInput); break;
					case "readActorGenerations": result = await entry.historyDataSource.readActorGenerations(requestInput); break;
					case "readActorMessages": result = await entry.historyDataSource.readActorMessages(requestInput); break;
					case "readRecords": result = await entry.historyDataSource.readRecords(requestInput); break;
					case "cursorAt": result = await entry.historyDataSource.cursorAt(requestInput); break;
					case "readVisitSession": result = await entry.historyDataSource.readVisitSession(requestInput); break;
					default: return sendJson(response, 400, { error: "Unknown history operation" });
				}
				return sendJson(response, 200, result === undefined ? { found: false } : { found: true, result });
			} catch (error) {
				return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		const steerToken = routeToken(url.pathname, "/api/runs/", "/steer");
		if (steerToken !== undefined) {
			if (request.method !== "POST") return sendText(response, 405, "Method not allowed");
			const entry = entries.get(steerToken);
			if (entry === undefined) return sendJson(response, 404, { error: "Inspector run not found or expired" });
			if (entry.steerSession === undefined) return sendJson(response, 409, { error: "Steering is unavailable for this run" });
			entry.touchedAt = Date.now();
			try {
				const body = await readJsonBody(request);
				if (typeof body.branchId !== "string" || !validBranchId(body.branchId) || typeof body.actionKey !== "string" || typeof body.message !== "string") {
					return sendJson(response, 400, { error: "valid branchId, actionKey, and message are required" });
				}
				await entry.steerSession(body.branchId, body.actionKey, body.message);
				return sendJson(response, 202, { queued: true });
			} catch (error) {
				return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		const apiToken = routeToken(url.pathname, "/api/runs/");
		if (apiToken !== undefined) {
			if (request.method !== "GET") return sendText(response, 405, "Method not allowed");
			const entry = entries.get(apiToken);
			if (entry === undefined) return sendJson(response, 404, { error: "Inspector run not found or expired" });
			entry.touchedAt = Date.now();
			try {
				const branchId = url.searchParams.get("branchId") ?? undefined;
				if (branchId !== undefined && !validBranchId(branchId)) return sendJson(response, 400, { error: "Invalid branch id" });
				return sendJson(response, 200, { run: await entry.loadRun(branchId) });
			} catch (error) {
				return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (request.method !== "GET") return sendText(response, 405, "Method not allowed");
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

function routeToken(pathname: string, prefix: string, suffix = ""): string | undefined {
	if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
	const token = pathname.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length);
	return /^[A-Za-z0-9_-]+$/.test(token) ? token : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 16_384) throw new Error("Request body is too large");
		chunks.push(buffer);
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("JSON object required");
	return value as Record<string, unknown>;
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
		return sendText(response, 503, "Inspector browser assets are missing. Rebuild @surprisal/hyperchart.");
	}
	response.statusCode = 200;
	response.setHeader("Content-Type", contentType);
	response.setHeader("Cache-Control", "no-cache");
	createReadStream(path).pipe(response);
}

function resolveInspectorAsset(fileName: string): string | undefined {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		// Built module: dist/inspect -> dist/inspector-web. Source module (jiti/tests): src/inspect -> dist/inspector-web.
		resolve(moduleDir, "../inspector-web", fileName),
		resolve(moduleDir, "../../dist/inspector-web", fileName),
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

function validBranchId(branchId: string): boolean {
	return branchId.trim().length > 0 && branchId.length <= 128 && !/[\0/\\]/.test(branchId);
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

/** Fixed inspector port for remote setups so `ssh -L` can be configured once; 0 picks a free port. */
function inspectorPort(): number {
	const raw = process.env.HYPERCHART_INSPECTOR_PORT;
	if (raw === undefined || raw.trim().length === 0) return 0;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`HYPERCHART_INSPECTOR_PORT must be a port number, got '${raw}'`);
	}
	return port;
}

function openSystemBrowser(url: string): Promise<void> {
	// Over SSH there is no local browser to open; the caller surfaces the URL and
	// the user opens it through a forwarded port on their own machine.
	if (process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined) {
		return Promise.resolve();
	}
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
