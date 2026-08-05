import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ActorMailboxCard } from "../components/inspector/details/ActorMailboxCard.js";
import { ActorInternalMessageHistory } from "../components/inspector/details/RuntimeSection.js";
import { actorReentryRun } from "../fixtures/actor-fixtures.js";
import { BoardPage } from "./components/index.js";

const receiveState = actorReentryRun.states.find((state) => state.id === "phase.@auditor.idle");
const replyState = actorReentryRun.states.find((state) => state.id === "phase.@auditor.settle");
const occurrence = actorReentryRun.actorOccurrences?.[0];
if (receiveState === undefined || replyState === undefined || occurrence === undefined) {
	throw new Error("actor history atlas requires the replay-valid reentry projection");
}
const receiveMessages = receiveState.actorInternal?.generations?.flatMap((generation) => generation.actorMessageHistory ?? []) ?? [];
const replyMessages = replyState.actorInternal?.generations?.flatMap((generation) => generation.actorMessageHistory ?? []) ?? [];

const meta = {
	title: "Hyperchart/Inspector/State Details/Actor History Atlas",
	id: "hyperchart-inspector-actor-history-atlas",
	parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj;

function AtlasCard({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
	return (
		<article data-testid={testId} className="min-w-0 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3">
			<h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
			{children}
		</article>
	);
}

export const CollapsedHistoriesAndPreviousMessages: Story = {
	name: "Receive, Reply, and Previous Messages",
	render: () => (
		<BoardPage
			title="Actor history card atlas"
			description="Compact production cards derived from the normalized, replay-valid actor reentry run; no duplicate dialogs or semantic view models."
		>
			<div className="grid gap-4 lg:grid-cols-3">
				<AtlasCard title="Receive History · selected receive state" testId="receive-history">
					<ActorInternalMessageHistory state={receiveState} messages={receiveMessages} />
				</AtlasCard>
				<AtlasCard title="Reply History · selected reply state" testId="reply-history">
					<ActorInternalMessageHistory state={replyState} messages={replyMessages} />
				</AtlasCard>
				<AtlasCard title="Mailbox History · generation instances" testId="previous-messages">
					<ActorMailboxCard instances={occurrence.mailboxInstances} />
				</AtlasCard>
			</div>
		</BoardPage>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const receive = within(canvas.getByTestId("receive-history"));
		const replies = within(canvas.getByTestId("reply-history"));
		const previous = within(canvas.getByTestId("previous-messages"));
		const firstMessageId = "phase.record:message:1:0";

		await expect(receive.getAllByRole("button")).toHaveLength(3);
		await expect(replies.getAllByRole("button")).toHaveLength(3);
		await expect(receive.queryByText(firstMessageId)).not.toBeInTheDocument();
		await expect(receive.queryByText("audit.log")).not.toBeInTheDocument();
		await expect(replies.queryByText(firstMessageId)).not.toBeInTheDocument();

		await userEvent.click(receive.getAllByRole("button")[0]!);
		await expect(receive.getByText(firstMessageId)).toBeVisible();
		await expect(receive.getAllByRole("button")[0]).toHaveTextContent("audit.log");
		await userEvent.click(replies.getAllByRole("button")[0]!);
		await expect(replies.getByText(firstMessageId)).toBeVisible();

		await expect(previous.getByText("Mailbox is empty.")).toBeVisible();
		await expect(previous.getAllByRole("button")).toHaveLength(1);
		await expect(previous.queryByText("RECORD")).not.toBeInTheDocument();
		await userEvent.click(previous.getByRole("button", { name: "Show history" }));
		await expect(previous.getByText("Latest instance · generation 3")).toBeVisible();
		await expect(previous.getByText("Instance · generation 2")).toBeVisible();
		await expect(previous.getByText("Instance · generation 1")).toBeVisible();
		await expect(previous.getAllByText("RECORD")).toHaveLength(3);
		await expect(previous.queryByText(firstMessageId)).not.toBeInTheDocument();
	},
};
