import { describe, expect, it } from "vitest";
import type { InputRef } from "../packages/hyperchart/src/index.js";
import {
	actor,
	agent,
	artifact,
	compound,
	failed,
	final,
	map,
	message,
	normalizeChartConfig,
	parallel,
	protocol,
	receive,
	reply,
	t,
	tsImport,
	user,
	z,
} from "../packages/hyperchart/src/index.js";
import { arg, artifactOf, chart, event, input, item, key, result, resume, visit } from "../packages/hyperchart/src/core/dsl.js";

describe("normalizeChartConfig", () => {
	it("normalizes serializable chart argument metadata into the frozen AST", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "launch-args",
				args: {
					topic: { description: "Subject to research", default: "Hyperchart" },
					options: { description: "Optional structured settings", default: { depth: 2, tags: ["dsl"] } },
				},
				initial: "done",
				states: { done: final() },
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		expect(result.ast.args).toEqual({
			topic: { description: "Subject to research", default: "Hyperchart" },
			options: { description: "Optional structured settings", default: { depth: 2, tags: ["dsl"] } },
		});
		expect(Object.isFrozen(result.ast.args)).toBe(true);
		expect(JSON.parse(JSON.stringify(result.ast.args))).toEqual(result.ast.args);
	});

	it("diagnoses malformed or non-serializable chart argument metadata", () => {
		const result = normalizeChartConfig({
			kind: "chart",
			id: "invalid-launch-args",
			args: {
				"": {},
				badSpec: "not metadata",
				badDescription: { description: 42 },
				badDefault: { default: { callback: () => undefined } },
				badSchema: { default: z.string() },
			},
			initial: "done",
			states: { done: final() },
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"INVALID_CHART_ARGUMENT",
			"INVALID_CHART_ARGUMENT",
			"INVALID_CHART_ARGUMENT",
			"INVALID_CHART_ARGUMENT",
			"INVALID_CHART_ARGUMENT",
		]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
			"/args/",
			"/args/badSpec",
			"/args/badDescription/description",
			"/args/badDefault/default/callback",
			"/args/badSchema/default",
		]);
	});

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
						transitions: { DONE: "done", ERROR: "failed" },
					},
					done: final(),
					failed: failed(),
				},
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		expect(result.ast.states.start?.kind).toBe("state");
		expect(Object.isFrozen(result.ast)).toBe(true);
		expect(Object.isFrozen(result.ast.states)).toBe(true);
	});

	it("normalizes explicit terminal outcomes and defaults raw finals to complete", () => {
		const parsed = normalizeChartConfig(chart({
			kind: "chart",
			id: "terminal-outcomes",
			initial: "done",
			states: { done: final(), failed: failed(), raw: { kind: "final" } },
		}));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected valid chart");
		expect(parsed.ast.states.done).toMatchObject({ kind: "final", outcome: "complete" });
		expect(parsed.ast.states.failed).toMatchObject({ kind: "final", outcome: "failed" });
		expect(parsed.ast.states.raw).toMatchObject({ kind: "final", outcome: "complete" });

		const invalid = normalizeChartConfig({
			id: "invalid-terminal-outcome",
			initial: "done",
			states: { done: { kind: "final", outcome: "success" } as never },
		});
		expect(invalid.ok).toBe(false);
		expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toContain("INVALID_FINAL_OUTCOME");
	});

	it("normalizes terminal notifications with an explicit render scope", () => {
		const parsed = normalizeChartConfig(chart({
			kind: "chart",
			id: "terminal-notify-scope",
			initial: "prepare",
			states: {
				prepare: { kind: "state", action: agent("prepare"), transitions: { READY: { target: "work", input: { topic: event("topic") } } } },
				work: { kind: "state", input: { topic: z.string() }, action: agent("work"), transitions: { DONE: "done" } },
				done: final({ notify: { scope: "work", prompt: t`Publish ${input("topic")}` } }),
			},
		}));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected valid chart");
		expect(parsed.ast.states.done).toMatchObject({
			kind: "final",
			notify: { scope: "work", prompt: { kind: "template", refs: [{ kind: "input", name: "topic" }] } },
		});
	});

	it("rejects malformed terminal notifications and invalid artifact references", () => {
		const malformed = normalizeChartConfig({
			id: "malformed-notify",
			initial: "done",
			states: { done: { kind: "final", notify: "bad" } as never },
		});
		expect(malformed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("INVALID_TERMINAL_NOTIFICATION");

		const invalid = normalizeChartConfig(chart({
			kind: "chart",
			id: "invalid-notify",
			initial: "work",
			states: {
				work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
				done: final({ notify: {
					scope: "missing",
					prompt: {} as never,
					artifacts: [artifactOf("work"), { kind: "not-an-artifact" } as never],
				} }),
			},
		}));
		const codes = invalid.diagnostics.map((diagnostic) => diagnostic.code);
		expect(codes).toEqual(expect.arrayContaining([
			"INVALID_TEMPLATE",
			"UNKNOWN_NOTIFICATION_SCOPE",
			"UNKNOWN_FILE_SOURCE",
			"INVALID_TERMINAL_NOTIFICATION",
		]));
	});

	it("applies dominance checks to terminal prompt and artifact reads", () => {
		const parsed = normalizeChartConfig(chart({
			kind: "chart",
			id: "terminal-dominance",
			initial: "start",
			states: {
				start: { kind: "state", action: agent("start"), transitions: { SKIP: "done", PRODUCE: "produce" } },
				produce: { kind: "state", action: agent("produce", { artifacts: { report: artifact("report.txt") } }), transitions: { DONE: "done" } },
				done: final({ notify: { prompt: t`Result ${result("produce")}`, artifacts: [artifactOf("produce")] } }),
			},
		}));
		expect(parsed.ok).toBe(false);
		expect(parsed.diagnostics.filter((diagnostic) => diagnostic.code === "NON_DOMINATED_REF")).toHaveLength(2);
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
						transitions: { ERROR: "done" },
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

	it("rejects onDone cycles in the enter-resolution chain", () => {
		const result = normalizeChartConfig({
			id: "enter-cycle",
			initial: "a",
			states: {
				a: compound({ initial: "af", onDone: "b", states: { af: final() } }),
				b: compound({ initial: "bf", onDone: "a", states: { bf: final() } }),
			},
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected diagnostics");
		expect(result.diagnostics.map((d) => d.code)).toContain("ON_DONE_CYCLE");
	});

	it("accepts onDone chains that settle on an action leaf", () => {
		const result = normalizeChartConfig({
			id: "enter-chain",
			initial: "a",
			states: {
				a: compound({
					initial: "work",
					onDone: "b",
					states: {
						work: { kind: "state" as const, action: agent("worker"), transitions: { OK: "af" } },
						af: final(),
					},
				}),
				b: compound({
					initial: "work",
					onDone: "done",
					states: {
						work: { kind: "state" as const, action: agent("worker"), transitions: { OK: "bf" } },
						bf: final(),
					},
				}),
				done: final(),
			},
		});

		expect(result.ok).toBe(true);
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
					states: { work: { kind: "state" as const, action: agent("coder"), transitions: { ERROR: "work" } } },
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

	it("infers an actor reply reachable only through after", () => {
		const TimedProtocol = protocol({ RUN: message({ input: z.object({}).strict(), reply: z.object({ timedOut: z.boolean() }).strict() }) });
		const Timed = actor({
			input: z.object({}).strict(), protocol: TimedProtocol, initial: "idle",
			states: {
				idle: receive({ on: { RUN: "work" } }),
				work: { kind: "state", action: agent("slow-worker"), transitions: {}, after: { delayMs: 10, target: "settle" } },
				settle: reply({ target: "idle", output: { timedOut: true } }),
			},
		});
		const timed = Timed({});
		const result = normalizeChartConfig(chart({
			kind: "chart", id: "actor-after-reply", actors: { timed }, initial: "done", states: { done: final() },
		}));

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
		expect(result.diagnostics).toEqual([]);
		expect(result.ast.actors["@timed"]?.states.settle).toMatchObject({ kind: "reply", message: "RUN" });
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
			initial: "plan",
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

	it("rejects non-dominated result and artifactOf refs", () => {
		const resultRef = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "non-dominated-result",
				initial: "start",
				states: {
					start: { kind: "state", action: agent("starter"), transitions: { SKIP: "read", DO: "produce" } },
					produce: { kind: "state", action: agent("producer"), transitions: { DONE: "read" } },
					read: {
						kind: "state",
						action: agent("reader", { task: t`Use ${result("produce")}` }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(resultRef.ok).toBe(false);
		expect(resultRef.diagnostics.map((d) => d.code)).toContain("NON_DOMINATED_REF");

		const artifactRef = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "non-dominated-artifact",
				initial: "start",
				states: {
					start: { kind: "state", action: agent("starter"), transitions: { SKIP: "read", DO: "produce" } },
					produce: {
						kind: "state",
						action: agent("producer", { artifacts: { out: artifact("out.json") } }),
						transitions: { DONE: "read" },
					},
					read: {
						kind: "state",
						action: agent("reader", { reads: [artifactOf("produce")] }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(artifactRef.ok).toBe(false);
		expect(artifactRef.diagnostics.map((d) => d.code)).toContain("NON_DOMINATED_REF");
	});

	it("allows dominated pull refs across back-edges and after parallel joins", () => {
		const backEdge = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "dominated-back-edge",
				initial: "produce",
				states: {
					produce: {
						kind: "state",
						action: agent("producer", { artifacts: { out: artifact("out.json") } }),
						transitions: { DONE: "gate" },
					},
					gate: { kind: "state", action: agent("gate"), transitions: { AGAIN: "produce", PASS: "read" } },
					read: {
						kind: "state",
						action: agent("reader", { task: t`Use ${result("produce")}`, reads: [artifactOf("produce")] }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(backEdge.diagnostics).toEqual([]);

		const joined = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "parallel-join-pull",
				initial: "audit",
				states: {
					audit: parallel({
						states: {
							a: compound({
								initial: "scan",
								states: {
									scan: {
										kind: "state",
										action: agent("a", { artifacts: { out: artifact("a.json") } }),
										transitions: { OK: "done" },
									},
									done: final(),
								},
							}),
							b: compound({
								initial: "scan",
								states: {
									scan: {
										kind: "state",
										action: agent("b", { artifacts: { out: artifact("b.json") } }),
										transitions: { OK: "done" },
									},
									done: final(),
								},
							}),
						},
						onDone: "fix",
					}),
					fix: {
						kind: "state",
						action: agent("fix", { reads: [artifactOf("audit.a.scan"), artifactOf("audit.b.scan")] }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(joined.diagnostics).toEqual([]);
	});

	it("rejects cross-region pull refs inside a parallel", () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "parallel-cross-region",
				initial: "audit",
				states: {
					audit: parallel({
						states: {
							a: compound({
								initial: "scan",
								states: {
									scan: {
										kind: "state",
										action: agent("a", { artifacts: { out: artifact("a.json") } }),
										transitions: { OK: "done" },
									},
									done: final(),
								},
							}),
							b: compound({
								initial: "read",
								states: {
									read: {
										kind: "state",
										action: agent("b", { reads: [artifactOf("audit.a.scan")] }),
										transitions: { OK: "done" },
									},
									done: final(),
								},
							}),
						},
						onDone: "done",
					}),
					done: final(),
				},
			}),
		);
		expect(parsed.ok).toBe(false);
		expect(parsed.diagnostics.map((d) => d.code)).toContain("NON_DOMINATED_REF");
	});

	it("normalizes transition input bindings and rejects missing or unknown input", () => {
		const valid = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "inputs",
				initial: "gate",
				states: {
					gate: {
						kind: "state",
						action: agent("gate"),
						transitions: { BLOCK: { target: "fix", input: { feedback: event("feedback") } } },
					},
					fix: {
						kind: "state",
						input: { feedback: z.string() },
						action: agent("fixer", { task: t`Fix ${input("feedback")}` }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(valid.ok).toBe(true);
		if (!valid.ok) throw new Error("expected valid chart");
		const gate = valid.ast.states.gate;
		expect(gate?.kind === "state" ? gate.transitions.BLOCK : undefined).toEqual({
			target: "fix",
			input: { feedback: { kind: "event", path: "feedback" } },
		});

		const missing = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "missing-input",
				initial: "gate",
				states: {
					gate: { kind: "state", action: agent("gate"), transitions: { BLOCK: "fix" } },
					fix: { kind: "state", input: { feedback: z.string() }, action: agent("fixer"), transitions: { OK: "done" } },
					done: final(),
				},
			}),
		);
		expect(missing.ok).toBe(false);
		expect(missing.diagnostics.map((d) => d.code)).toContain("MISSING_INPUT");

		const unknown = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "unknown-input",
				initial: "gate",
				states: {
					gate: {
						kind: "state",
						action: agent("gate"),
						transitions: { BLOCK: { target: "fix", input: { extra: event() } } },
					},
					fix: { kind: "state", action: agent("fixer"), transitions: { OK: "done" } },
					done: final(),
				},
			}),
		);
		expect(unknown.ok).toBe(false);
		expect(unknown.diagnostics.map((d) => d.code)).toContain("UNKNOWN_INPUT");
	});

	it("allows defaulted input without a binding and rejects FAILED input bindings", () => {
		const defaulted = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "default-input",
				initial: "work",
				states: {
					work: {
						kind: "state",
						input: { feedback: z.string().default("none") },
						action: agent("worker", { task: t`${input("feedback")}` }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(defaulted.ok).toBe(true);

		const failedBinding = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "failed-binding",
				initial: "work",
				states: {
					work: {
						kind: "state",
						input: { feedback: z.string().default("none") },
						action: agent("worker"),
						transitions: { FAILED: { target: "done", input: { feedback: event() } } },
					},
					done: final(),
				},
			}),
		);
		expect(failedBinding.ok).toBe(false);
		expect(failedBinding.diagnostics.map((d) => d.code)).toContain("RESERVED_FAILED_TRANSITION");
	});

	it("normalizes visit refs and rejects non-action visit refs", () => {
		const valid = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "visits",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker", { task: t`Visit ${visit()}` }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(valid.ok).toBe(true);

		const invalid = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "bad-visits",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker", { task: t`Visit ${visit("done")}` }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(invalid.ok).toBe(false);
		expect(invalid.diagnostics.map((d) => d.code)).toContain("INVALID_VISIT_REF");
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

	it("normalizes onReenter resume for agents and rejects meaningless resume targets", () => {
		const valid = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "on-reenter",
				initial: "work",
				states: {
					work: {
						kind: "state",
						input: { feedback: z.string().default("none") },
						onReenter: resume(t`Fix: ${input("feedback")}`),
						action: agent("coder"),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(valid.ok).toBe(true);
		if (!valid.ok) throw new Error("expected valid chart");
		const work = valid.ast.states.work;
		expect(work?.kind === "state" ? work.onReenter : undefined).toMatchObject({ kind: "resume" });

		const invalid = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "bad-on-reenter",
				initial: "ask",
				states: {
					ask: {
						kind: "state",
						onReenter: resume("Ask again"),
						action: user({ prompt: "Continue?" }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(invalid.ok).toBe(false);
		expect(invalid.diagnostics.map((d) => d.code)).toContain("INVALID_ON_REENTER");
	});

	it("validates the retry budget declaration", () => {
		const withoutValidate = normalizeChartConfig({
			id: "no-validate",
			initial: "work",
			states: {
				work: { action: agent("coder"), retries: 2, transitions: { DONE: "done", ERROR: "done" } },
				done: final(),
			},
		});
		expect(withoutValidate.ok).toBe(false);
		expect(withoutValidate.diagnostics.map((d) => d.code)).toContain("INVALID_RETRIES");

		const noRoute = normalizeChartConfig({
			id: "no-route",
			initial: "work",
			states: {
				work: {
					action: agent("coder"),
					validate: tsImport("./checks.js", "testsPass"),
					retries: 2,
					transitions: { DONE: "done" }, // nowhere for the exhausted budget to go
				},
				done: final(),
			},
		});
		expect(noRoute.ok).toBe(true);
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
				ask: { action: user({ prompt: "Pick", options: ["FAILED"] }), transitions: { ERROR: "done" } },
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

	it("normalizes a map into a compound-shaped node with over and concurrency", () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "mapped",
				initial: "plan",
				states: {
					plan: { kind: "state", action: agent("planner"), transitions: { OK: "chapters" } },
					chapters: map({
						over: result("plan", "chapters"),
						concurrency: 2,
						initial: "author",
						onDone: "done",
						states: {
							author: {
								kind: "state",
								action: agent("author", { task: t`Write ${key()}: ${item("title")}` }),
								transitions: { OK: "written" },
							},
							written: final(),
						},
					}),
					done: final(),
				},
			}),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ast.states.chapters).toMatchObject({
			kind: "map",
			over: { kind: "result", state: "plan", path: "chapters" },
			concurrency: 2,
			initial: "author",
			onDone: "done",
		});
		expect(parsed.ast.states["chapters.author"]?.kind).toBe("state");
	});

	it("requires over, onDone, a final child and a sane concurrency on maps", () => {
		const parsed = normalizeChartConfig({
			id: "bad-map",
			initial: "chapters",
			states: {
				chapters: {
					kind: "map",
					concurrency: 0,
					initial: "author",
					states: {
						author: { kind: "state" as const, action: agent("author"), transitions: { OK: "author" } },
					},
				},
				done: final(),
			},
		});
		expect(parsed.ok).toBe(false);
		const codes = parsed.diagnostics.map((d) => d.code);
		expect(codes).toContain("INVALID_MAP");
		expect(codes).toContain("MISSING_ON_DONE");
		expect(codes).toContain("MISSING_FINAL");
	});

	it("rejects key()/item() refs outside any map and over reading an unknown result", () => {
		const parsed = normalizeChartConfig({
			id: "bad-refs",
			initial: "solo",
			states: {
				solo: {
					kind: "state" as const,
					action: agent("writer", { task: t`Write ${key()} of ${item("title")}` }),
					transitions: { OK: "chapters" },
				},
				chapters: map({
					over: result("missing", "chapters"),
					initial: "author",
					onDone: "done",
					states: {
						author: { kind: "state" as const, action: agent("author"), transitions: { OK: "written" } },
						written: final(),
					},
				}),
				done: final(),
			},
		});
		expect(parsed.ok).toBe(false);
		const codes = parsed.diagnostics.map((d) => d.code);
		expect(codes.filter((code) => code === "INVALID_MAP_REF")).toHaveLength(2);
		expect(codes).toContain("UNKNOWN_INPUT_RESULT");

		// A ref naming its map explicitly must sit inside THAT map, not just any map.
		const wrongMap = normalizeChartConfig({
			id: "wrong-map",
			initial: "chapters",
			states: {
				chapters: map({
					over: arg("items"),
					initial: "author",
					onDone: "done",
					states: {
						author: {
							kind: "state" as const,
							action: agent("author", {
								task: t`${{ kind: "item", map: "other", path: "title" } as InputRef<string>}`,
							}),
							transitions: { OK: "written" },
						},
						written: final(),
					},
				}),
				done: final(),
			},
		});
		expect(wrongMap.ok).toBe(false);
		expect(wrongMap.diagnostics.map((d) => d.code)).toContain("INVALID_MAP_REF");
	});
});
