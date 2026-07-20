import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { HyperchartRunInfo } from "@surprisal/hyperchart/host";
import {
	closeRunInspectorServer,
	openRunInspector,
} from "../packages/hyperchart/src/inspect/inspector_server.js";

afterEach(async () => {
	await closeRunInspectorServer();
});

describe("browser run inspector server", () => {
	it("binds to loopback, serves a registered run, and reuses one server", async () => {
		const opened: string[] = [];
		const first = await openRunInspector({
			runId: "run-one",
			loadRun: async () => ({ runId: "run-one", status: "running" }) as unknown as HyperchartRunInfo,
			openBrowser: (url) => {
				opened.push(url);
			},
		});
		const second = await openRunInspector({
			runId: "run-two",
			loadRun: async () => ({ runId: "run-two", status: "complete" }) as unknown as HyperchartRunInfo,
			openBrowser: (url) => {
				opened.push(url);
			},
		});

		expect(new URL(first.url).hostname).toBe("127.0.0.1");
		expect(new URL(first.url).origin).toBe(new URL(second.url).origin);
		expect(first.url).not.toBe(second.url);
		expect(opened).toEqual([first.url, second.url]);

		const token = new URL(second.url).pathname.split("/").at(-1);
		const response = await fetch(`${new URL(second.url).origin}/api/runs/${token}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ run: { runId: "run-two", status: "complete" } });
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("accepts steering only through the registered run token", async () => {
		const steering: Array<{ actionKey: string; message: string }> = [];
		const { url } = await openRunInspector({
			runId: "run-one",
			loadRun: async () => ({ runId: "run-one" }) as HyperchartRunInfo,
			steerSession: (actionKey, message) => {
				steering.push({ actionKey, message });
			},
			openBrowser: () => undefined,
		});
		const response = await fetch(`${url.replace("/runs/", "/api/runs/")}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ actionKey: "agent-key", message: "Check the narrow layout" }),
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ queued: true });
		expect(steering).toEqual([{ actionKey: "agent-key", message: "Check the narrow layout" }]);
	});

	it("does not expose unregistered run tokens", async () => {
		const { url } = await openRunInspector({
			runId: "run-one",
			loadRun: async () => ({ runId: "run-one" }) as HyperchartRunInfo,
			openBrowser: () => undefined,
		});
		const response = await fetch(`${new URL(url).origin}/api/runs/not-registered`);
		expect(response.status).toBe(404);
	});
});

describe("remote-friendly inspector options", () => {
	afterEach(async () => {
		delete process.env.HYPERCHART_INSPECTOR_PORT;
		delete process.env.SSH_CONNECTION;
		await closeRunInspectorServer();
	});

	it("binds the port from HYPERCHART_INSPECTOR_PORT", async () => {
		const probe = await new Promise<number>((resolve, reject) => {
			const server = createServer();
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (address === null || typeof address === "string") return reject(new Error("no port"));
				server.close(() => resolve(address.port));
			});
		});
		process.env.HYPERCHART_INSPECTOR_PORT = String(probe);
		const { url } = await openRunInspector({
			runId: "fixed-port",
			loadRun: async () => ({ runId: "fixed-port" }) as never,
			openBrowser: () => undefined,
		});
		expect(new URL(url).port).toBe(String(probe));
	});

	it("does not try to open a server-side browser under SSH", async () => {
		process.env.SSH_CONNECTION = "203.0.113.5 50000 203.0.113.9 22";
		// No openBrowser stub: without the SSH guard this would spawn a real browser.
		const { url } = await openRunInspector({
			runId: "ssh-run",
			loadRun: async () => ({ runId: "ssh-run" }) as never,
		});
		expect((await fetch(url)).status).toBe(200);
	});
});
