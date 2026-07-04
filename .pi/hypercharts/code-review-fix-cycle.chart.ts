import { agent, artifact, compound, final, parallel, refs, z } from "../../src/index.js";

const Finding = z.object({
	severity: z.enum(["blocker", "major", "minor", "nit"]),
	file: z.string().optional(),
	line: z.number().int().positive().optional(),
	issue: z.string(),
	recommendation: z.string(),
});

const Review = z.object({
	angle: z.enum(["correctness", "security", "maintainability"]),
	verdict: z.enum(["approved", "changes_requested"]),
	summary: z.string(),
	findings: z.array(Finding),
});

const ReviewReply = z.object({
	verdict: z.enum(["approved", "changes_requested"]),
	summary: z.string(),
	blockingFindings: z.number().int().nonnegative(),
});

const FixReport = z.object({
	status: z.enum(["fixed", "done", "blocked"]),
	summary: z.string(),
	changedFiles: z.array(z.string()),
	validation: z.array(z.string()),
	remainingIssues: z.array(z.string()),
});

type Review = z.infer<typeof Review>;
type ReviewReply = z.infer<typeof ReviewReply>;
type FixReport = z.infer<typeof FixReport>;

const { chart, artifactOf } = refs<
	Record<string, never>,
	{
		"review.correctness.scan": ReviewReply;
		"review.security.scan": ReviewReply;
		"review.maintainability.scan": ReviewReply;
		fix: FixReport;
	},
	{
		"review.correctness.scan": { review: Review };
		"review.security.scan": { review: Review };
		"review.maintainability.scan": { review: Review };
		fix: { report: FixReport };
	}
>();

function reviewer(angle: "correctness" | "security" | "maintainability", focus: string, path: string) {
	return compound({
		initial: "scan",
		states: {
			scan: {
				kind: "state",
				action: agent("hyperchart-code-reviewer", {
					task: `Review the current workspace changes in this repository. Inspect git status, git diff, staged changes, and relevant untracked files.

Angle: ${angle}.
Focus: ${focus}.

Write a concise JSON review artifact. Use verdict "approved" only when there are no actionable findings for this angle; otherwise use "changes_requested".`,
					artifacts: { review: artifact(path, Review) },
					reply: ReviewReply,
				}),
				transitions: { REVIEWED: "done" },
			},
			done: final(),
		},
	});
}

export default chart({
	kind: "chart",
	id: "code-review-fix-cycle",
	initial: "review",
	states: {
		review: parallel({
			states: {
				correctness: reviewer(
					"correctness",
					"Correctness, regressions, edge cases, data flow, tests that should exist, and whether the implementation satisfies the intended behavior.",
					".pi/hypercharts/artifacts/code-review-fix-cycle/correctness-review.json",
				),
				security: reviewer(
					"security",
					"Security, privacy, injection, unsafe shell/file/network behavior, secret exposure, and permission boundaries.",
					".pi/hypercharts/artifacts/code-review-fix-cycle/security-review.json",
				),
				maintainability: reviewer(
					"maintainability",
					"Maintainability, architecture fit, simplicity, naming, readability, error handling, and long-term change risk.",
					".pi/hypercharts/artifacts/code-review-fix-cycle/maintainability-review.json",
				),
			},
			onDone: "fix",
			transitions: { FAILED: "failed" },
		}),

		fix: {
			kind: "state",
			action: agent("hyperchart-code-fixer", {
				task: "Read the three review artifacts for the current workspace changes. If any actionable blocker/major/minor issue remains, make the smallest safe code changes and finish with FIXED. If the reviewers approve or only non-actionable nits remain, make no edits and finish with DONE. If you cannot proceed safely, finish with BLOCKED.",
				reads: [
					artifactOf("review.correctness.scan"),
					artifactOf("review.security.scan"),
					artifactOf("review.maintainability.scan"),
				],
				artifacts: {
					report: artifact(".pi/hypercharts/artifacts/code-review-fix-cycle/fix-report.json", FixReport),
				},
				reply: FixReport,
			}),
			transitions: { FIXED: "review", DONE: "done", BLOCKED: "failed", FAILED: "failed" },
		},

		done: final(),
		failed: final(),
	},
});
