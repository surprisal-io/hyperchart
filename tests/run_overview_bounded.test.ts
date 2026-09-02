import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createBranchProjection, projectBranch } from "../packages/hyperchart/src/core/projection.js";
import { overviewOnly } from "../packages/hyperchart/src/inspect/run_inspect.js";
import {
	mailboxReentryAst,
	mailboxReentryRecords,
	mailboxReentryRun,
} from "../packages/hyperchart/src/react/fixtures/actor-runtime-fixtures.js";
import { actorPoolAst, actorPoolBusyRecords, actorPoolBusyRun } from "../packages/hyperchart/src/react/fixtures/actor-fixtures.js";
import { ActorMailboxCard } from "../packages/hyperchart/src/react/components/inspector/details/ActorMailboxCard.js";

describe("bounded run overview", () => {
	it("keeps mailbox count/head summaries without queued or elapsed arrays", () => {
		const source = structuredClone(mailboxReentryRun);
		const actor = source.actorOccurrences?.[0];
		const seed = actor?.mailbox.head;
		if (actor === undefined || seed === undefined) throw new Error("mailbox fixture is incomplete");
		actor.mailbox.entries = Array.from({ length: 20_000 }, (_, index) => ({ ...seed, messageId: `queued-${index}` }));
		actor.mailbox.totalCount = actor.mailbox.entries.length;
		const latestInstance = actor.mailboxInstances.at(-1);
		if (latestInstance === undefined) throw new Error("mailbox instance fixture is incomplete");
		latestInstance.mailbox = { totalCount: 20_000, head: seed, entries: actor.mailbox.entries };
		actor.mailboxInstances[0]!.messageHistory = Array.from({ length: 20_000 }, (_, index) => ({ ...seed, messageId: `settled-${index}` }));
		const records = mailboxReentryRecords(mailboxReentryAst);
		const projection = projectBranch(createBranchProjection(mailboxReentryAst), mailboxReentryAst, records);

		const overview = overviewOnly(source, projection);
		const bounded = overview.actorOccurrences?.[0];
		expect(bounded?.mailbox).toMatchObject({ totalCount: 20_000, head: { messageId: seed.messageId } });
		expect(bounded?.mailbox).not.toHaveProperty("entries");
		expect(bounded?.mailboxInstances).toHaveLength(1);
		expect(bounded?.mailboxInstances[0]).not.toHaveProperty("messageHistory");
		expect(bounded?.mailboxInstances[0]?.mailbox).not.toHaveProperty("entries");
		expect(JSON.stringify(overview)).not.toContain("queued-19999");
		expect(JSON.stringify(overview)).not.toContain("settled-19999");

		const markup = renderToStaticMarkup(createElement(ActorMailboxCard, { instances: bounded?.mailboxInstances ?? [] }));
		expect(markup).toContain(`>${seed.event}<`);
		expect(markup).toContain("Showing the retained mailbox head.");
		expect(markup).toContain("20,000 queued in the pinned overview");
		expect(markup).not.toContain("Mailbox is empty.");
	});

	it("recursively strips pool worker visit and message histories", () => {
		const source = structuredClone(actorPoolBusyRun);
		const pool = source.actorOccurrences?.find((actor) => actor.kind === "actorPool");
		if (pool?.workers?.[0] === undefined) throw new Error("pool fixture is incomplete");
		const worker = pool.workers[0];
		const seed = worker.currentMessage ?? pool.mailbox.head;
		if (seed === undefined) throw new Error("pool message fixture is incomplete");
		worker.messageHistory = Array.from({ length: 10_000 }, (_, index) => ({ ...seed, messageId: `worker-${index}` }));
		worker.visitHistory = Array.from({ length: 10_000 }, (_, index) => ({ visit: index + 1, invokeSeqId: index + 1, startedAt: index, status: "done" as const, invocation: { kind: "actor" as const } }));
		const records = actorPoolBusyRecords;
		const projection = projectBranch(createBranchProjection(actorPoolAst), actorPoolAst, records);

		const overview = overviewOnly(source, projection);
		for (const occurrence of overview.actorOccurrences ?? []) for (const summary of occurrence.workers ?? []) {
			expect(summary).not.toHaveProperty("messageHistory");
			expect(summary).not.toHaveProperty("visitHistory");
			expect(summary.session).not.toHaveProperty("messages");
		}
		for (const state of overview.states) for (const summary of state.actorOccurrence?.workers ?? []) {
			expect(summary).not.toHaveProperty("messageHistory");
			expect(summary).not.toHaveProperty("visitHistory");
		}
	});
});
