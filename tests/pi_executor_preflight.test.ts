import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import type { AgentEffect, AgentOutcome } from "../packages/hyperchart/src/core/machine.js";
import { PiAgentExecutor } from "../packages/pi-hyperchart/src/runtime/pi/pi_agent_executor.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

it.each(["supersede", "cancel", "dispose"] as const)("settles real SDK before_agent_start preflight before shutdown on %s", async (operation) => {
	const root = await mkdtemp(join(tmpdir(), "hyperchart-preflight-"));
	const bridgeKey = `preflight-${randomUUID()}`;
	const entered = deferred();
	const release = deferred();
	const abortReturned = deferred();
	const bridge = { entered: entered.resolve, release: release.promise, gated: false, resources: 0, events: [] as string[], errors: [] as string[] };
	Reflect.set(globalThis, bridgeKey, bridge);
	let executor: PiAgentExecutor | undefined;
	try {
		await mkdir(join(root, "extensions"));
		await mkdir(join(root, "sessions"));
		await writeFile(join(root, "worker.md"), "---\ndescription: preflight fixture\n---\nCall finish.\n");
		await writeFile(join(root, "extensions", "preflight.ts"), `
export default function(pi) {
  const bridge = globalThis[${JSON.stringify(bridgeKey)}];
  let timer;
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!bridge.gated) {
      bridge.gated = true;
      bridge.events.push("preflight");
      bridge.entered();
      await bridge.release;
    }
    try {
      const id = ctx.sessionManager.getSessionId();
      bridge.events.push("acquire:" + id);
      timer = setInterval(() => {}, 1000);
      bridge.resources++;
    } catch (error) {
      bridge.errors.push(String(error));
      throw error;
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    bridge.events.push("shutdown:" + ctx.sessionManager.getSessionId());
    if (timer !== undefined) { clearInterval(timer); timer = undefined; bridge.resources--; }
  });
}`);
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false });
		const model = modelRuntime.getModels("anthropic")[0];
		if (model === undefined) throw new Error("Missing fixture model");
		await modelRuntime.setRuntimeApiKey(model.provider, "isolated-test-key");
		// Only provider I/O is substituted. Real prompt, preflight, abort and idle detection run.
		let requests = 0;
		vi.spyOn(modelRuntime, "streamSimple").mockImplementation(() => {
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				// Bound the fake provider even when testing a broken/invalidation path.
				content: ++requests <= 2 ? [{ type: "toolCall", id: randomUUID(), name: "finish", arguments: { event: "DONE" } }] : [{ type: "text", text: "stop" }],
				stopReason: requests <= 2 ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
			// The workspace has two pi-ai copies with nominally private stream fields.
			// This test-only I/O substitute uses their identical async-iterator contract.
			return stream as unknown as ReturnType<ModelRuntime["streamSimple"]>;
		});
		const abort = AgentSession.prototype.abort;
		vi.spyOn(AgentSession.prototype, "abort").mockImplementation(async function (this: AgentSession) {
			await abort.call(this);
			abortReturned.resolve();
		});
		const dispose = AgentSession.prototype.dispose;
		vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
			bridge.events.push(`dispose:${this.sessionId}`);
			dispose.call(this);
		});
		let handles = 0;
		executor = new PiAgentExecutor({ workDir: root, agentDir: root, definitionDirs: [root], sessionsDir: join(root, "sessions"), branchId: "main", modelRuntime,
			defaultModel: `${model.provider}/${model.id}`, extensionPolicy: "ambient",
			sessionService: {
				async openOrCreate(sessionId) {
					handles++;
					return { manager: SessionManager.inMemory(root, { id: sessionId }), sessionId, restored: false,
						async drain() {}, async close() { handles--; bridge.events.push(`close:${sessionId}`); } };
				},
				async readTranscript() { return undefined; }, async close() { expect(handles).toBe(0); },
			},
		});
		const actionUid = { chart: "preflight", state: "work", action: "worker" };
		const effect: AgentEffect = { kind: "agent", id: "preflight:work:worker:1:1", actionUid,
			action: { kind: "agent", uid: actionUid, name: "worker", onFail: { nudge: 2, restart: 1 }, tools: ["finish"] }, events: ["DONE", "FAILED"], sessionId: "first" };
		const firstEmission = vi.fn();
		executor.start(effect, firstEmission);
		await entered.promise;
		const current = executor;
		let nextCompletion: Promise<AgentOutcome> | undefined;
		let cancellation: Promise<void> | undefined;
		if (operation === "supersede") nextCompletion = new Promise((resolve) => current.start({ ...effect, id: "preflight:work:worker:2:2", sessionId: "second" }, resolve));
		else cancellation = operation === "cancel" ? executor.cancel(actionUid) : executor.dispose();
		await abortReturned.promise;
		await new Promise((resolve) => setImmediate(resolve));
		// The actual SDK abort returned while the extension is still awaiting preflight.
		expect(bridge.events).toEqual(["preflight"]);
		expect(handles).toBe(1);
		release.resolve();
		if (nextCompletion !== undefined) expect(await nextCompletion).toEqual({ kind: "completed", event: { type: "DONE" } });
		await cancellation;
		await executor.dispose();
		expect(firstEmission).not.toHaveBeenCalled();
		expect(bridge.errors).toEqual([]);
		expect(bridge.resources).toBe(0);
		expect(requests).toBeLessThanOrEqual(2);
		expect(handles).toBe(0);
		const expected = ["preflight", "acquire:first", "shutdown:first", "dispose:first", "close:first"];
		if (operation === "supersede") expected.push("acquire:second", "shutdown:second", "dispose:second", "close:second");
		expect(bridge.events).toEqual(expected);
	} finally {
		release.resolve();
		await executor?.dispose().catch(() => {});
		vi.restoreAllMocks();
		Reflect.deleteProperty(globalThis, bridgeKey);
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
