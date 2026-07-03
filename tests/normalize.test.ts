import { describe, expect, it } from "vitest";
import {
	agent,
	arg,
	chart,
	compound,
	final,
	normalizeChartConfig,
	parallel,
	result,
	t,
	tsImport,
	user,
	z,
} from "../src/index.js";

describe("normalizeChartConfig", () => {
	it("normalizes a valid chart into a frozen AST", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "ok",
				initial: "start",
				states: {
					start: {
						kind: "state",
						action: agent("worker", {
							reply: z.object({ value: z.string() }),
						}),
						transitions: { DONE: "done", FAILED: "failed" },
					},
					done: final(),
					failed: final(),
				},
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		expect(result.ast.states.start?.kind).toBe("state");
		expect(Object.isFrozen(result.ast)).toBe(true);
		expect(Object.isFrozen(result.ast.states)).toBe(true);
	});

	it("normalizes validate with a default onReject of resume", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "validated",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("coder"),
						validate: tsImport("./checks.js", "testsPass"),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		const work = result.ast.states.work;
		if (work?.kind !== "state") throw new Error("expected action state");
		expect(work.validate).toEqual({ kind: "tsImport", module: "./checks.js", export: "testsPass" });
		expect(work.onReject).toBe("resume");
	});

	it("normalizes compounds into a flat path-keyed AST", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "nested",
				initial: "review",
				states: {
					review: compound({
						initial: "analyze",
						onDone: "done",
						states: {
							analyze: { kind: "state", action: agent("analyzer"), transitions: { OK: "verified" } },
							verified: final(),
						},
						transitions: { FAILED: "done" },
					}),
					done: final(),
				},
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		const review = result.ast.states.review;
		if (review?.kind !== "compound") throw new Error("expected compound state");
		expect(review.initial).toBe("analyze");
		expect(review.onDone).toBe("done");
		const analyze = result.ast.states["review.analyze"];
		if (analyze?.kind !== "state") throw new Error("expected nested action state");
		expect(analyze.parent).toBe("review");
		expect(analyze.action.uid.state).toBe("review.analyze");
	});

	it("rejects state ids with reserved characters", () => {
		const result = normalizeChartConfig({
			id: "bad-ids",
			initial: "work",
			states: {
				"work.step": { action: agent("coder"), transitions: {} },
				work: { action: agent("coder"), transitions: {} },
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("INVALID_STATE_ID");
	});

	it("requires every compound to have a final child and declare onDone", () => {
		const missing = normalizeChartConfig({
			id: "missing-on-done",
			initial: "review",
			states: {
				review: compound({
					initial: "work",
					states: {
						work: { kind: "state" as const, action: agent("coder"), transitions: { OK: "finished" } },
						finished: final(),
					},
				}),
				done: final(),
			},
		});
		expect(missing.ok).toBe(false);
		expect(missing.diagnostics.map((d) => d.code)).toContain("MISSING_ON_DONE");

		const useless = normalizeChartConfig({
			id: "useless-on-done",
			initial: "review",
			states: {
				review: compound({
					initial: "work",
					onDone: "done",
					states: { work: { kind: "state" as const, action: agent("coder"), transitions: { FAILED: "work" } } },
				}),
				done: final(),
			},
		});
		expect(useless.ok).toBe(false);
		// A compound with no final child cannot complete: forbidden rather than "onDone is dead".
		expect(useless.diagnostics.map((d) => d.code)).toContain("MISSING_FINAL");
	});

	it("resolves targets among siblings of the declaring level only", () => {
		const result = normalizeChartConfig({
			id: "cross-branch",
			initial: "review",
			states: {
				review: compound({
					initial: "work",
					onDone: "nowhere",
					states: {
						// "done" is a top-level state, not a sibling of work: not addressable from here.
						work: { kind: "state" as const, action: agent("coder"), transitions: { OK: "done" } },
						finished: final(),
					},
				}),
				done: final(),
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toEqual(
			expect.arrayContaining(["UNKNOWN_TRANSITION_TARGET", "UNKNOWN_ON_DONE_TARGET"]),
		);
	});

	it("normalizes parallel states with regions", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "par",
				initial: "audit",
				states: {
					audit: parallel({
						states: {
							security: compound({
								initial: "scan",
								states: {
									scan: { kind: "state", action: agent("sec"), transitions: { OK: "ok" } },
									ok: final(),
								},
							}),
							perf: compound({
								initial: "scan",
								states: {
									scan: { kind: "state", action: agent("perf"), transitions: { OK: "ok" } },
									ok: final(),
								},
							}),
						},
						onDone: "merge",
					}),
					merge: final(),
				},
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		const audit = result.ast.states.audit;
		if (audit?.kind !== "parallel") throw new Error("expected parallel state");
		expect(audit.regions).toEqual(["security", "perf"]);
		expect(result.ast.states["audit.security.scan"]?.kind).toBe("state");
	});

	it("rejects onDone on regions and region transitions targeting siblings", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "bad-regions",
				initial: "audit",
				states: {
					audit: parallel({
						states: {
							security: compound({
								initial: "scan",
								onDone: "perf", // regions must not exit through onDone
								transitions: { RETRY: "perf" }, // and may only restart themselves
								states: {
									scan: { kind: "state", action: agent("sec"), transitions: { OK: "ok" } },
									ok: final(),
								},
							}),
							perf: compound({
								initial: "scan",
								states: {
									scan: { kind: "state", action: agent("perf"), transitions: { OK: "ok" } },
									ok: final(),
								},
							}),
						},
						onDone: "merge",
					}),
					merge: final(),
				},
			}),
		);

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toEqual(
			expect.arrayContaining(["REGION_ON_DONE", "INVALID_REGION_TARGET"]),
		);
	});

	it("requires completable regions and onDone on every parallel", () => {
		const region = (name: string, withFinal: boolean) =>
			compound({
				initial: "scan",
				states: {
					scan: {
						kind: "state" as const,
						action: agent(name),
						transitions: withFinal ? { OK: "ok" } : { OK: "scan" },
					},
					...(withFinal ? { ok: final() } : {}),
				},
			});

		const missing = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "missing",
				initial: "audit",
				states: {
					audit: parallel({ states: { a: region("a", true), b: region("b", true) } }),
					merge: final(),
				},
			}),
		);
		expect(missing.ok).toBe(false);
		expect(missing.diagnostics.map((d) => d.code)).toContain("MISSING_ON_DONE");

		const useless = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "useless",
				initial: "audit",
				states: {
					audit: parallel({ states: { a: region("a", true), b: region("b", false) }, onDone: "merge" }),
					merge: final(),
				},
			}),
		);
		expect(useless.ok).toBe(false);
		// A region that can never reach a final would make the join unreachable: forbidden.
		expect(useless.diagnostics.map((d) => d.code)).toContain("MISSING_FINAL");
	});

	it("normalizes after on an action state", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "timed",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("coder"),
						after: { delayMs: 500, target: "escalated" },
						transitions: { DONE: "done" },
					},
					done: final(),
					escalated: final(),
				},
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		const work = result.ast.states.work;
		if (work?.kind !== "state") throw new Error("expected action state");
		expect(work.after).toEqual({ delayMs: 500, target: "escalated" });
	});

	it("rejects invalid after shapes and unknown after targets", () => {
		const badDelay = normalizeChartConfig({
			id: "bad-delay",
			initial: "work",
			states: {
				work: { action: agent("coder"), after: { delayMs: -1, target: "done" }, transitions: { DONE: "done" } },
				done: final(),
			},
		});
		expect(badDelay.ok).toBe(false);
		expect(badDelay.diagnostics.map((d) => d.code)).toContain("INVALID_AFTER");

		const unknownTarget = normalizeChartConfig({
			id: "bad-target",
			initial: "work",
			states: {
				work: { action: agent("coder"), after: { delayMs: 500, target: "missing" }, transitions: { DONE: "done" } },
				done: final(),
			},
		});
		expect(unknownTarget.ok).toBe(false);
		expect(unknownTarget.diagnostics.map((d) => d.code)).toContain("UNKNOWN_AFTER_TARGET");
	});

	it("normalizes templates and validates their refs", () => {
		const valid = normalizeChartConfig({
			id: "templates",
			initial: "build",
			states: {
				plan: { action: agent("planner"), transitions: { OK: "build" } },
				build: {
					action: agent("builder", {
						task: t`Build ${arg("topic")} following ${result("plan", "steps")}`,
						artifacts: { claims: "claims.json" },
					}),
					transitions: { OK: "done" },
				},
				done: final(),
			},
		});
		expect(valid.diagnostics).toEqual([]);
		if (!valid.ok) throw new Error("expected valid chart");
		const build = valid.ast.states.build;
		if (build?.kind !== "state" || build.action.kind !== "agent") throw new Error("expected agent state");
		expect(build.action.task).toEqual({
			kind: "template",
			strings: ["Build ", " following ", ""],
			refs: [
				{ kind: "arg", name: "topic" },
				{ kind: "result", state: "plan", path: "steps" },
			],
		});
		// A plain string artifact is a no-refs template path with no declared shape.
		expect(build.action.artifacts).toEqual({
			claims: { path: { kind: "template", strings: ["claims.json"], refs: [] } },
		});

		const inline = normalizeChartConfig({
			id: "bad-template",
			initial: "build",
			states: {
				build: {
					action: agent("builder", { task: { kind: "template", strings: ["a", "b"], refs: [42] } as never }),
					transitions: { OK: "done" },
				},
				done: final(),
			},
		});
		expect(inline.ok).toBe(false);
		expect(inline.diagnostics.map((d) => d.code)).toContain("INVALID_TEMPLATE");

		const unknownResult = normalizeChartConfig({
			id: "unknown-result",
			initial: "build",
			states: {
				build: {
					action: agent("builder", { task: t`From ${result("missing")}` }),
					transitions: { OK: "done" },
				},
				done: final(),
			},
		});
		expect(unknownResult.ok).toBe(false);
		expect(unknownResult.diagnostics.map((d) => d.code)).toContain("UNKNOWN_INPUT_RESULT");
	});

	it("rejects artifactOf reads pointing at states without artifacts", () => {
		const result = normalizeChartConfig({
			id: "bad-file-source",
			initial: "reader",
			states: {
				writer: { action: agent("writer"), transitions: { OK: "reader" } }, // no output declared
				reader: {
					action: agent("reader", { reads: [{ kind: "artifactOf", state: "writer" }] }),
					transitions: { OK: "done" },
				},
				done: final(),
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("UNKNOWN_FILE_SOURCE");
	});

	it("shape-checks agent frontmatter overrides", () => {
		const bad = normalizeChartConfig({
			id: "bad-overrides",
			initial: "build",
			states: {
				build: {
					action: agent("builder", { model: "", tools: "write" } as never),
					transitions: { OK: "done" },
				},
				done: final(),
			},
		});
		expect(bad.ok).toBe(false);
		expect(bad.diagnostics.map((d) => d.code)).toEqual(["INVALID_AGENT_OPTION", "INVALID_AGENT_OPTION"]);
	});

	it("rejects inline functions as validators", () => {
		const result = normalizeChartConfig({
			id: "inline-validate",
			initial: "work",
			states: {
				work: {
					action: agent("coder"),
					validate: () => true,
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("INVALID_GUARD");
	});

	it("rejects onReject without validate and invalid onReject values", () => {
		const withoutValidate = normalizeChartConfig({
			id: "no-validate",
			initial: "work",
			states: {
				work: { action: agent("coder"), onReject: "resume", transitions: { DONE: "done" } },
				done: final(),
			},
		});
		expect(withoutValidate.ok).toBe(false);
		expect(withoutValidate.diagnostics.map((d) => d.code)).toContain("INVALID_ON_REJECT");

		const badValue = normalizeChartConfig({
			id: "bad-on-reject",
			initial: "work",
			states: {
				work: {
					action: agent("coder"),
					validate: tsImport("./checks.js", "testsPass"),
					onReject: "explode",
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		});
		expect(badValue.ok).toBe(false);
		expect(badValue.diagnostics.map((d) => d.code)).toContain("INVALID_ON_REJECT");
	});

	it("reports invalid initial state and transition targets", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "broken",
				initial: "missing",
				states: {
					start: { kind: "state", action: agent("worker"), transitions: { DONE: "missing" } },
				},
			}),
		);

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toEqual(
			expect.arrayContaining(["UNKNOWN_INITIAL_STATE", "UNKNOWN_TRANSITION_TARGET"]),
		);
	});

	it("reports missing action on non-final states", () => {
		const result = normalizeChartConfig({
			id: "broken",
			initial: "start",
			states: {
				start: {},
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("MISSING_ACTION");
	});

	it("rejects custom user events named FAILED", () => {
		const result = normalizeChartConfig({
			id: "broken",
			initial: "ask",
			states: {
				ask: { action: user({ prompt: "Pick", options: ["FAILED"] }), transitions: { FAILED: "done" } },
				done: final(),
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("RESERVED_EVENT_EMIT");
	});

	it("rejects non-zod shape declarations", () => {
		const result = normalizeChartConfig({
			id: "broken",
			initial: "start",
			states: {
				start: {
					action: { kind: "agent", name: "worker", reply: { kind: "jsonSchema", schema: { type: "object" } } },
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("INVALID_SCHEMA");
	});
});
