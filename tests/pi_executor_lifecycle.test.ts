import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEffect, AgentOutcome } from "../packages/hyperchart/src/core/machine.js";
import type { ChartEvent } from "../packages/hyperchart/src/core/types.js";
import {
	PiAgentExecutor,
	type PiExtensionPolicy,
	type PiSessionService,
} from "../packages/pi-hyperchart/src/runtime/pi/pi_agent_executor.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function effect(visit = 1): AgentEffect {
	const actionUid = { chart: "resources", state: "work", action: "worker" };
	return {
		kind: "agent",
		id: `resources:work:worker:${visit}:${visit}`,
		actionUid,
		action: {
			kind: "agent",
			uid: actionUid,
			name: "worker",
			onFail: { nudge: 2, restart: 1 },
			tools: ["read", "grep", "finish"],
		},
		events: ["DONE", "FAILED"],
		sessionId: `resource-session-${visit}`,
	};
}

async function fixture(extensionPolicy: PiExtensionPolicy = "isolated") {
	const root = await mkdtemp(join(tmpdir(), "hyperchart-session-resources-"));
	roots.push(root);
	await mkdir(join(root, "extensions"));
	await mkdir(join(root, "sessions"));
	await writeFile(join(root, "worker.md"), "---\ndescription: resource worker\n---\nChart worker instructions\n");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
		modelsStorePath: join(root, "models-store.json"),
	});
	const counts = { handles: 0, subscriptions: 0, shutdown: 0, disposed: 0, created: 0 };
	const order: string[] = [];
	const opened: string[] = [];
	const stored = new Map<
		string,
		{ header: NonNullable<ReturnType<SessionManager["getHeader"]>>; entries: ReturnType<SessionManager["getEntries"]> }
	>();
	const service: PiSessionService = {
		async openOrCreate(id) {
			opened.push(id);
			const saved = stored.get(id);
			// The workspace SDK predates arbitrary external IDs; the service still
			// receives/asserts the exact durable ID, while its test manager uses a legal local ID.
			const manager = SessionManager.inMemory(root, { id: id.replaceAll(":", "-") });
			for (const entry of saved?.entries ?? []) {
				if (entry.type === "message" && entry.message.role === "user") {
					manager.appendMessage(entry.message);
				}
			}
			counts.handles++;
			return {
				manager,
				sessionId: id,
				restored: saved !== undefined,
				async drain() {
					order.push("drain");
				},
				async close() {
					counts.handles--;
					stored.set(id, { header: manager.getHeader()!, entries: manager.getEntries() });
					order.push("close");
				},
			};
		},
		async readTranscript() {
			return undefined;
		},
		async close() {
			expect(counts.handles).toBe(0);
		},
	};
	const overrides = vi.fn(async () => undefined);
	const executor = new PiAgentExecutor({
		resolveSessionOverrides: overrides,
		workDir: root,
		projectDir: root,
		agentDir: root,
		definitionDirs: [root],
		sessionsDir: join(root, "sessions"),
		branchId: "main",
		modelRuntime,
		...(extensionPolicy === "ambient" ? {} : { extensionPolicy }),
		sessionService: service,
	});
	const subscribe = AgentSession.prototype.subscribe;
	vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation(function (this: AgentSession, listener) {
		counts.subscriptions++;
		const unsubscribe = subscribe.call(this, listener);
		return () => {
			counts.subscriptions--;
			unsubscribe();
		};
	});
	const dispose = AgentSession.prototype.dispose;
	vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
		counts.disposed++;
		order.push("dispose");
		dispose.call(this);
	});
	const seenSessions = new WeakSet<AgentSession>();
	const prompts: Array<{ id: string; text: string; entries: number }> = [];
	const prompt = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
		this: AgentSession,
		text,
	) {
		prompts.push({ id: this.sessionId, text, entries: this.sessionManager.getEntries().length });
		// Exercise real SDK extension contexts without invoking a provider. The
		// fixture starts a resource as a normal host would, then executor owns teardown.
		if (!seenSessions.has(this)) {
			seenSessions.add(this);
			counts.created++;
			await this.bindExtensions({ mode: "print" });
			const emit = this.extensionRunner.emit.bind(this.extensionRunner);
			vi.spyOn(this.extensionRunner, "emit").mockImplementation(async (event) => {
				if (event.type === "session_shutdown") {
					counts.shutdown++;
					order.push("shutdown");
				}
				return emit(event);
			});
		}
		this.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		const finish = this.agent.state.tools.find((tool) => tool.name === "finish")!;
		await finish.execute("finish-call", { event: "DONE" });
	});
	return { root, executor, counts, order, prompts, prompt, stored, opened, service, overrides };
}

function complete(executor: PiAgentExecutor, invocation: AgentEffect): Promise<ChartEvent> {
	return new Promise((resolve) =>
		executor.start(invocation, (outcome: AgentOutcome) =>
			resolve(outcome.kind === "completed" ? outcome.event : { type: "FAILED", error: outcome.failure.message }),
		),
	);
}

const internal = (executor: PiAgentExecutor) =>
	executor as unknown as {
		live: Map<string, unknown>;
		runs: Map<string, unknown>;
		cleanupSession(session: AgentSession): Promise<void>;
	};

describe("PiAgentExecutor session resources", () => {
	it("closes completed sessions, progress and recorders before delivery over 100 isolated cycles", async () => {
		const f = await fixture();
		try {
			for (let i = 1; i <= 100; i++) {
				expect(await complete(f.executor, effect(i))).toEqual({ type: "DONE" });
				expect(f.counts.handles).toBe(0);
				expect(f.counts.subscriptions).toBe(0);
				expect(internal(f.executor).live.size).toBe(0);
				expect(f.order.slice(-4)).toEqual(["drain", "shutdown", "dispose", "close"]);
			}
			await new Promise((resolve) => setImmediate(resolve));
			expect(internal(f.executor).runs.size).toBe(0);
			expect(f.counts).toEqual({ created: 100, disposed: 100, shutdown: 100, handles: 0, subscriptions: 0 });
			console.log(
				"resource regression: 100 cycles; completed live sessions=0, progress subscriptions=0, recorder handles=0; shutdown=dispose=100",
			);
		} finally {
			await f.executor.dispose();
		}
	}, 30_000);

	it("reports artifact failure after cleanup and accepts a durable nudge on the same session", async () => {
		const f = await fixture();
		const prompt = f.prompt.getMockImplementation()!;
		let turns = 0;
		f.prompt.mockImplementation(async function (this: AgentSession, text, options) {
			if (++turns === 2) {
				await writeFile(join(f.root, "result.txt"), "accepted");
			}
			return prompt.call(this, text, options);
		});
		try {
			const invocation = { ...effect(), artifacts: [{ path: "result.txt" }] };
			expect((await complete(f.executor, invocation)).type).toBe("FAILED");
			expect(
				await complete(f.executor, {
					...invocation,
					id: "resources:work:worker:1:2",
					recovery: {
						mode: "nudge",
						scope: "general",
						nudgeAttempt: 1,
						restartAttempt: 0,
						failure: { kind: "artifacts", message: "missing result" },
					},
				}),
			).toEqual({ type: "DONE" });
			expect(turns).toBe(2);
			expect(f.opened).toEqual(["resource-session-1", "resource-session-1"]);
			expect(f.counts).toEqual({ created: 2, disposed: 2, shutdown: 2, handles: 0, subscriptions: 0 });
		} finally {
			await f.executor.dispose();
		}
	});

	it.each(["nudge", "restart"] as const)("reopens the correct transcript for durable recovery (%s)", async (mode) => {
		const f = await fixture();
		try {
			const invocation = effect();
			expect(await complete(f.executor, invocation)).toEqual({ type: "DONE" });
			const retry: AgentEffect = {
				...invocation,
				id: "resources:work:worker:1:2",
				sessionId: mode === "nudge" ? invocation.sessionId : "fresh-session-id",
				recovery: {
					mode,
					scope: "validation",
					nudgeAttempt: mode === "nudge" ? 1 : 0,
					restartAttempt: mode === "restart" ? 1 : 0,
					failure: { kind: "validation", message: "fix output" },
				},
			};
			expect(await complete(f.executor, retry)).toEqual({ type: "DONE" });
			expect(f.opened[1]).toBe(mode === "nudge" ? invocation.sessionId : "fresh-session-id");
			expect(f.prompts[1]?.text).toContain("fix output");
			if (mode === "nudge") {
				const firstEntries = f.prompts[0]?.entries;
				const secondEntries = f.prompts[1]?.entries;
				if (firstEntries === undefined || secondEntries === undefined) {
					throw new Error("missing prompt entries");
				}
				expect(secondEntries).toBeGreaterThan(firstEntries);
			}
			expect(f.counts.handles).toBe(0);
			expect(f.counts.disposed).toBe(2);
		} finally {
			await f.executor.dispose();
		}
	});

	it("runs shutdown exactly once before invalidation even when cancellation and disposal race", async () => {
		const f = await fixture();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		f.prompt.mockImplementationOnce(async function (this: AgentSession) {
			const emit = this.extensionRunner.emit.bind(this.extensionRunner);
			vi.spyOn(this.extensionRunner, "emit").mockImplementation(async (event) => {
				if (event.type === "session_shutdown") {
					f.counts.shutdown++;
					f.order.push("shutdown");
				}
				return emit(event);
			});
			vi.spyOn(this, "abort").mockImplementation(async () => {
				release();
			});
			entered();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const emitted = vi.fn();
		f.executor.start(effect(), emitted);
		await started;
		await Promise.all([f.executor.cancel(effect().actionUid), f.executor.dispose(), f.executor.dispose()]);
		expect(emitted).not.toHaveBeenCalled();
		expect(f.counts).toMatchObject({ shutdown: 1, disposed: 1, handles: 0, subscriptions: 0 });
		expect(f.order.filter((item) => item !== "drain")).toEqual(["shutdown", "dispose", "close"]);
	});

	it("serializes superseding starts and suppresses stale completions without overlapping recorders", async () => {
		const f = await fixture();
		const open = f.service.openOrCreate.bind(f.service);
		f.service.openOrCreate = async (id) => {
			expect(f.counts.handles).toBe(0);
			return open(id);
		};
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		f.prompt.mockImplementationOnce(async function (this: AgentSession) {
			vi.spyOn(this, "abort").mockImplementation(async () => {
				release();
			});
			entered();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const first = vi.fn();
		const second = vi.fn();
		f.executor.start(effect(1), first);
		await started;
		f.executor.start(effect(2), second);
		expect(await complete(f.executor, effect(3))).toEqual({ type: "DONE" });
		expect(first).not.toHaveBeenCalled();
		expect(second).not.toHaveBeenCalled();
		expect(f.opened).toEqual(["resource-session-1", "resource-session-3"]);
		expect(f.counts).toMatchObject({ disposed: 2, subscriptions: 0, handles: 0 });
		await f.executor.dispose();
	});

	it("cancels the current replacement while the previous generation is still shutting down", async () => {
		const f = await fixture();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let releaseAbort!: () => void;
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		let releasePrompt!: () => void;
		f.prompt.mockImplementationOnce(async function (this: AgentSession) {
			vi.spyOn(this, "abort").mockImplementation(async () => {
				await abortGate;
				releasePrompt();
			});
			entered();
			await new Promise<void>((resolve) => {
				releasePrompt = resolve;
			});
		});
		const emitted = vi.fn();
		f.executor.start(effect(1), emitted);
		await started;
		f.executor.start(effect(2), emitted);
		const cancellation = f.executor.cancel(effect(2).actionUid);
		releaseAbort();
		await cancellation;
		expect(emitted).not.toHaveBeenCalled();
		expect(f.opened).toEqual(["resource-session-1"]);
		expect(f.counts).toMatchObject({ disposed: 1, subscriptions: 0, handles: 0 });
		await f.executor.dispose();
	});

	it("waits for a recorder opened during cancellation and closes it without starting a session", async () => {
		const f = await fixture();
		const open = f.service.openOrCreate.bind(f.service);
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.service.openOrCreate = async (id) => {
			entered();
			await gate;
			return open(id);
		};
		const emitted = vi.fn();
		f.executor.start(effect(), emitted);
		await started;
		const disposal = f.executor.dispose();
		release();
		await disposal;
		expect(f.counts).toMatchObject({ handles: 0, subscriptions: 0, disposed: 0, created: 0 });
		expect(f.order).toEqual(["close"]);
		expect(emitted).not.toHaveBeenCalled();
	});

	it("still disposes and closes exactly once when shutdown throws", async () => {
		const f = await fixture();
		const order: string[] = [];
		const session = {
			async abort() {
				order.push("abort");
			},
			extensionRunner: {
				async emit() {
					order.push("shutdown");
					throw new Error("shutdown failed");
				},
			},
			dispose() {
				order.push("dispose");
			},
		} as unknown as AgentSession;
		const handles = (f.executor as unknown as { sessionHandles: WeakMap<AgentSession, object> }).sessionHandles;
		handles.set(session, {
			async close() {
				order.push("close");
			},
		});
		const first = internal(f.executor).cleanupSession(session);
		expect(internal(f.executor).cleanupSession(session)).toBe(first);
		await expect(first).resolves.toBeUndefined();
		expect(order).toEqual(["abort", "shutdown", "dispose", "close"]);
		expect(handles.has(session)).toBe(false);
		await expect(f.executor.dispose()).rejects.toThrow("Failed to dispose Pi agent executor cleanly");
	});

	it("closes an opened recorder when SDK session construction fails", async () => {
		const f = await fixture();
		const open = f.service.openOrCreate.bind(f.service);
		f.service.openOrCreate = async (id) => {
			const handle = await open(id);
			vi.spyOn(handle.manager, "getSessionId").mockImplementation(() => {
				throw new Error("fixture SDK construction failure");
			});
			return handle;
		};
		expect(await complete(f.executor, effect())).toEqual({ type: "FAILED", error: "fixture SDK construction failure" });
		expect(f.counts).toMatchObject({ handles: 0, subscriptions: 0, created: 0 });
		expect(f.order).toEqual(["close"]);
		await f.executor.dispose();
	});

	it("does not deliver a successful finish when recorder close fails", async () => {
		const f = await fixture();
		const open = f.service.openOrCreate.bind(f.service);
		f.service.openOrCreate = async (id) => {
			const handle = await open(id);
			return {
				...handle,
				async close() {
					await handle.close();
					throw new Error("fixture recorder failure");
				},
			};
		};
		expect(await complete(f.executor, effect())).toMatchObject({
			type: "FAILED",
			error: "Failed to clean up Pi agent session",
		});
		expect(f.counts).toMatchObject({ disposed: 1, shutdown: 1, handles: 0, subscriptions: 0 });
		await f.executor.dispose();
	});

	it("closes recorders and subscriptions after prompt failure", async () => {
		const f = await fixture();
		f.prompt.mockRejectedValueOnce(new Error("provider failed"));
		expect(await complete(f.executor, effect())).toMatchObject({ type: "FAILED", error: "provider failed" });
		expect(f.counts).toMatchObject({ disposed: 1, handles: 0, subscriptions: 0 });
		expect(internal(f.executor).live.size).toBe(0);
		await f.executor.dispose();
	});

	it.each([
		"ambient",
		"isolated",
	] as const)("enforces %s extension discovery without removing instructions or built-in/finish tools", async (policy) => {
		const f = await fixture(policy);
		const marker = join(f.root, "extension-events.txt");
		await writeFile(
			join(f.root, "extensions", "monitor.ts"),
			`import { appendFileSync } from "node:fs";
export default function(pi) {
  appendFileSync(${JSON.stringify(marker)}, "factory\\n");
  let timer;
  pi.on("session_start", () => { timer = setInterval(() => {}, 1000); });
  pi.on("session_shutdown", (_event, ctx) => {
    clearInterval(timer);
    appendFileSync(${JSON.stringify(marker)}, "shutdown:" + ctx.sessionManager.getSessionId() + "\\n");
  });
}`,
		);
		const original = f.prompt.getMockImplementation()!;
		f.prompt.mockImplementationOnce(async function (this: AgentSession, text, options) {
			expect(this.agent.state.systemPrompt).toContain("Chart worker instructions");
			expect(this.agent.state.tools.map((tool) => tool.name).sort()).toEqual(["finish", "grep", "read"]);
			return original.call(this, text, options);
		});
		try {
			expect(await complete(f.executor, effect())).toEqual({ type: "DONE" });
			const { readFile } = await import("node:fs/promises");
			if (policy === "ambient") {
				expect(await readFile(marker, "utf8")).toBe("factory\nshutdown:resource-session-1\n");
			} else {
				await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
			}
		} finally {
			await f.executor.dispose();
		}
	});
});

it("supplies the durable invocation ID to session overrides rather than an SDK session ID", async () => {
	const { executor, overrides } = await fixture();
	await complete(executor, effect(1));
	await complete(executor, effect(2));
	expect(overrides).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({ invocationId: effect(1).sessionId, branchId: "main", actionUid: effect(1).actionUid }),
	);
	expect(overrides).toHaveBeenNthCalledWith(2, expect.objectContaining({ invocationId: effect(2).sessionId }));
	await executor.dispose();
});
