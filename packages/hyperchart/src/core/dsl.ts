import type { z } from "zod";
import type {
	AgentActionCst,
	ActorDefinitionCst,
	ActorWorkflowStateCst,
	CallStateCst,
	ChartCst,
	CompoundStateCst,
	EventBindingCst,
	FinalStateCst,
	GuardRef,
	ArtifactCst,
	ArtifactOfCst,
	JoinArtifactOfCst,
	InputRef,
	MapStateCst,
	OnReenterCst,
	ProtocolCst,
	ProtocolMessageCst,
	ReceiveStateCst,
	ReplyStateCst,
	SchemaCst,
	SendStateCst,
	StaticActorDeclaration,
	ParallelStateCst,
	ScriptActionCst,
	Templatable,
	TemplateCst,
	UserActionCst,
	ValueExpr,
} from "./types.js";

export function chart<const C extends ChartCst>(input: C): C {
	return input;
}

export const createChart = chart;

type InferSchema<S> = S extends z.ZodType ? z.infer<S> : unknown;
export type MessageTypes<P extends ProtocolCst> = keyof P & string;
export type MessageInput<P extends ProtocolCst, M extends keyof P> = P[M] extends { input: infer S }
	? InferSchema<S>
	: never;
export type ReplyEvents<P extends ProtocolCst, M extends keyof P> = P[M] extends {
	replies: infer R extends Record<string, SchemaCst>;
}
	? keyof R & string
	: never;
export type ReplyOutput<
	P extends ProtocolCst,
	M extends keyof P,
	R extends string = ReplyEvents<P, M>,
> = P[M] extends { replies: infer Replies extends Record<string, SchemaCst> }
	? R extends keyof Replies
		? InferSchema<Replies[R]>
		: never
	: P[M] extends { reply: infer S }
		? InferSchema<S>
		: void;
export type ReplyUnion<P extends ProtocolCst, M extends keyof P> = P[M] extends {
	replies: infer Replies extends Record<string, SchemaCst>;
}
	? { [R in keyof Replies]: InferSchema<Replies[R]> }[keyof Replies]
	: P[M] extends { reply: infer S }
		? InferSchema<S>
		: void;

export function message<const I extends SchemaCst>(options: {
	input: I;
}): { input: I };
export function message<const I extends SchemaCst, const R extends SchemaCst>(options: {
	input: I;
	reply: R;
	replies?: never;
}): { input: I; reply: R };
export function message<
	const I extends SchemaCst,
	const R extends Record<string, SchemaCst>,
>(options: { input: I; reply?: never; replies: R }): { input: I; replies: R };
export function message(options: ProtocolMessageCst): ProtocolMessageCst {
	return options;
}

export function protocol<const P extends ProtocolCst>(messages: P): P {
	return messages;
}

type ActorPlacement<T> = T extends string | number | boolean | null
	? T | InputRef<T>
	: T extends readonly (infer E)[]
		? readonly ActorPlacement<E>[] | InputRef<T>
		: T extends object
			? { [K in keyof T]: ActorPlacement<T[K]> } | InputRef<T>
			: ValueExpr<T>;

export type ActorTemplate<P extends ProtocolCst, I, Brand> = {
	(input: ActorPlacement<I>): StaticActorDeclaration<P, I, Brand>;
	readonly definition: ActorDefinitionCst;
};

type ActorPath<T> = T extends readonly unknown[]
	? never
	: T extends object
		? { [K in keyof T & string]: K | `${K}.${ActorPath<NonNullable<T[K]>>}` }[keyof T & string]
		: never;
type ActorValueAt<T, Path extends string> = Path extends `${infer Head}.${infer Tail}`
	? Head extends keyof T ? ActorValueAt<NonNullable<T[Head]>, Tail> : never
	: Path extends keyof T ? T[Path] : never;
type RefSelected<T, Path> = Path extends string ? ActorValueAt<T, Path> : T;

type ActorInputRefMarker<Path extends string | undefined> = { readonly __actorInputPath: Path };
type ActorMessageInputRefMarker<Message extends string, Path extends string | undefined> = { readonly __actorMessage: Message; readonly __actorMessagePath: Path };
type ActorResultRefMarker<State extends string, Path extends string | undefined> = { readonly __actorResultState: State; readonly __actorResultPath: Path };
type ActorStateInputRefMarker<Name extends string, Path extends string | undefined> = { readonly __actorStateInput: Name; readonly __actorStateInputPath: Path };
type ActorArtifactRefMarker<State extends string, Artifact extends string | undefined, Select extends string | undefined> = { readonly __actorArtifactState: State; readonly __actorArtifactName: Artifact; readonly __actorArtifactSelect: Select };

type StateSuccessors<Node> = Node extends { kind: "state"; transitions: infer T; after?: infer A }
	? (T extends Record<string, infer V> ? V extends string ? V : V extends { target: infer Target extends string } ? Target : never : never) | (A extends { target: infer Target extends string } ? Target : never)
	: Node extends { kind: "send"; target: infer Target extends string }
		? Target
		: Node extends { kind: "call"; target: infer Target extends string }
			? Target
			: Node extends { kind: "call"; transitions: infer T }
				? T extends Record<string, infer V> ? V extends string ? V : V extends { target: infer Target extends string } ? Target : never : never
				: never;

type Reaches<S, Current extends string, Goal extends string, Seen extends string = never> = Current extends Goal
	? true
	: Current extends Seen
		? false
		: Current extends keyof S
			? StateSuccessors<S[Current]> extends infer Next
				? Next extends string ? Reaches<S, Next, Goal, Seen | Current> : false
				: false
			: false;
type ReceiveTargets<S, Message extends string> = {
	[K in keyof S & string]: S[K] extends { kind: "receive"; on: infer On }
		? Message extends keyof On ? On[Message] & string : never
		: never;
}[keyof S & string];
type MessageReaches<S, Message extends string, Goal extends string> = true extends Reaches<S, ReceiveTargets<S, Message>, Goal> ? true : false;
type MessagesAt<P extends ProtocolCst, S, Goal extends string> = {
	[M in keyof P & string]: MessageReaches<S, M, Goal> extends true ? M : never;
}[keyof P & string];
type IsUnion<T, Whole = T> = T extends unknown ? ([Whole] extends [T] ? false : true) : never;
type SingleMessage<T> = [T] extends [never] ? never : true extends IsUnion<T> ? never : T;

type ActionReplyFor<S, State extends string> = State extends keyof S
	? S[State] extends { action: { reply: infer Reply } } ? InferSchema<Reply> : never
	: never;
type ActionInputFor<S, State extends string, Name extends string> = State extends keyof S
	? S[State] extends { input: infer Inputs } ? Name extends keyof Inputs ? InferSchema<Inputs[Name]> : never : never
	: never;
type ArtifactFor<S, State extends string, Name extends string | undefined> = State extends keyof S
	? S[State] extends { action: { artifacts: infer Artifacts } }
		? Name extends keyof Artifacts
			? Artifacts[Name] extends { shape: infer Shape } ? InferSchema<Shape> : unknown
			: Name extends undefined
				? Artifacts[keyof Artifacts] extends { shape: infer Shape } ? InferSchema<Shape> : unknown
				: never
		: never
	: never;

type ResolveActorValue<Value, P extends ProtocolCst, I, S> = Value extends ActorInputRefMarker<infer Path>
	? RefSelected<I, Path>
	: Value extends ActorMessageInputRefMarker<infer Message, infer Path>
		? Message extends keyof P ? RefSelected<MessageInput<P, Message>, Path> : never
		: Value extends ActorResultRefMarker<infer State, infer Path>
			? RefSelected<ActionReplyFor<S, State>, Path>
			: Value extends ActorStateInputRefMarker<infer Name, infer Path>
				? Value
				: Value extends readonly unknown[]
					? { [K in keyof Value]: ResolveActorValue<Value[K], P, I, S> }
					: Value extends object
						? { [K in keyof Value as K extends `__${string}` ? never : K]: ResolveActorValue<Value[K], P, I, S> }
						: Value;
type SameShape<Actual, Expected> = [Actual] extends [never] ? false : [Actual] extends [Expected] ? true : false;

type ReplyIsValid<Node, Contract, P extends ProtocolCst, I, S> = Contract extends { input: unknown; replies: infer Replies extends Record<string, SchemaCst> }
	? Node extends { event: infer Event extends keyof Replies; output: infer Output }
		? SameShape<ResolveActorValue<Output, P, I, S>, InferSchema<Replies[Event]>>
		: false
	: Contract extends { input: unknown; reply: infer Reply }
		? "event" extends keyof Node ? false
			: Node extends { output: infer Output } ? SameShape<ResolveActorValue<Output, P, I, S>, InferSchema<Reply>> : false
		: "event" extends keyof Node ? false : "output" extends keyof Node ? false : true;
type ReplyNodeValid<P extends ProtocolCst, I, S, Id extends keyof S & string> = S[Id] extends { kind: "reply" }
	? [SingleMessage<MessagesAt<P, S, Id>>] extends [never]
		? false
		: SingleMessage<MessagesAt<P, S, Id>> extends infer Message
			? Message extends keyof P ? ReplyIsValid<S[Id], P[Message], P, I, S> : false
			: false
	: true;
type AllPathsReachReply<S, Current, Seen extends string = never> = [Current] extends [never]
	? false
	: false extends (Current extends string
		? Current extends Seen
			? false
			: Current extends keyof S
				? S[Current] extends { kind: "reply" }
					? true
					: AllPathsReachReply<S, StateSuccessors<S[Current]>, Seen | Current>
				: false
		: false)
		? false
		: true;
type MessageAllPathsReply<S, Message extends string> = AllPathsReachReply<S, ReceiveTargets<S, Message>>;
type ReceiveNodeValid<P extends ProtocolCst, S, Id extends keyof S & string> = S[Id] extends { kind: "receive"; on: infer On }
	? Exclude<keyof On, keyof P> extends never
		? false extends { [Message in keyof On & string]: MessageAllPathsReply<S, Message> }[keyof On & string] ? false : true
		: false
	: true;
type PathValid<Value, Path> = Path extends undefined ? true : Path extends ActorPath<Value> ? true : false;
type SelectorValid<Value, P extends ProtocolCst, I, S, Id extends keyof S & string> = Value extends ActorInputRefMarker<infer Path>
	? PathValid<I, Path>
	: Value extends ActorMessageInputRefMarker<infer Message, infer Path>
		? Message extends keyof P
			? Message extends MessagesAt<P, S, Id> ? PathValid<MessageInput<P, Message>, Path> : false
			: false
		: Value extends ActorResultRefMarker<infer State, infer Path>
			? ActionReplyFor<S, State> extends never ? false : PathValid<ActionReplyFor<S, State>, Path>
			: Value extends ActorStateInputRefMarker<infer Name, infer Path>
				? PathValid<ActionInputFor<S, Id, Name>, Path>
				: Value extends ActorArtifactRefMarker<infer State, infer Name, infer Select>
					? ArtifactFor<S, State, Name> extends never ? false : PathValid<ArtifactFor<S, State, Name>, Select>
					: Value extends readonly unknown[]
						? false extends { [K in keyof Value]: SelectorValid<Value[K], P, I, S, Id> }[number] ? false : true
						: Value extends InputRef ? true
							: Value extends object
								? false extends { [K in keyof Value]: SelectorValid<Value[K], P, I, S, Id> }[keyof Value] ? false : true
								: true;
type TemplateValues<Value> = Value extends { readonly __actorRefs?: infer Refs } ? Refs : never;
type ArtifactPathValues<Artifacts> = Artifacts extends Record<string, infer Artifact>
	? Artifact extends { path: infer Path } ? TemplateValues<Path> : TemplateValues<Artifact>
	: never;
type ActionValues<Action> = Action extends { kind: "agent" }
	? TemplateValues<Action extends { task: infer Task } ? Task : never>
		| (Action extends { reads: infer Reads } ? Reads : never)
		| ArtifactPathValues<Action extends { artifacts: infer Artifacts } ? Artifacts : never>
	: Action extends { kind: "script" }
		? (Action extends { env: infer Env } ? Env[keyof Env] : never)
			| ArtifactPathValues<Action extends { artifacts: infer Artifacts } ? Artifacts : never>
		: Action extends { kind: "user" }
			? TemplateValues<Action extends { prompt: infer Prompt } ? Prompt : never>
			: never;
type NodeValues<Node> = Node extends { kind: "reply"; output: infer Output } ? Output
	: Node extends { kind: "send"; input: infer Input } ? Input
	: Node extends { kind: "send"; inputs: infer Inputs } ? Inputs
	: Node extends { kind: "call"; input: infer Input } ? Input
	: Node extends { kind: "state"; action: infer Action } ? ActionValues<Action>
	: never;
type NodeSelectorsValid<P extends ProtocolCst, I, S, Id extends keyof S & string> = [NodeValues<S[Id]>] extends [never]
	? true
	: SelectorValid<NodeValues<S[Id]>, P, I, S, Id>;
type ReservedNodeValid<Node> = Node extends { transitions: infer Transitions }
	? "FAILED" extends keyof Transitions ? false : true
	: true;
type ActorReplyGraphValid<P extends ProtocolCst, I, S> = false extends {
	[K in keyof S & string]: ReplyNodeValid<P, I, S, K> extends true
		? ReceiveNodeValid<P, S, K> extends true ? ReservedNodeValid<S[K]> : false
		: false;
}[keyof S & string] ? false : true;
type ActorSelectorsValid<P extends ProtocolCst, I, S> = false extends {
	[K in keyof S & string]: NodeSelectorsValid<P, I, S, K>;
}[keyof S & string] ? false : true;
type ActorVerification<I extends SchemaCst, P extends ProtocolCst, S, Initial extends string> = Initial extends keyof S
	? S[Initial] extends { kind: "receive" }
		? ActorReplyGraphValid<P, InferSchema<I>, S> extends true
			? ActorSelectorsValid<P, InferSchema<I>, S> extends true ? unknown : { readonly "actor-local selector is invalid": never }
			: { readonly "actor protocol/reply graph is invalid": never }
		: { readonly "actor initial state must be receive()": never }
	: { readonly "actor initial state is unknown": never };

/** Creates a reusable authoring-time template; invocation creates a static capability only. */
export function actor<
	const I extends SchemaCst,
	const P extends ProtocolCst,
	const S extends Record<string, ActorWorkflowStateCst>,
	const Initial extends keyof S & string,
>(options: { input: I; protocol: P; initial: Initial; states: S } & ActorVerification<I, P, S, Initial>): ActorTemplate<P, InferSchema<I>, S> {
	const definition: ActorDefinitionCst = { kind: "actorTemplate", input: options.input, protocol: options.protocol, initial: options.initial, states: options.states };
	const template = ((input: ActorPlacement<InferSchema<I>>) => ({
		kind: "actorDeclaration" as const,
		definition,
		input: input as ValueExpr<InferSchema<I>>,
	})) as ActorTemplate<P, InferSchema<I>, S>;
	Object.defineProperty(template, "definition", { enumerable: false, value: definition });
	return template;
}

export function receive<const O extends Omit<ReceiveStateCst, "kind">>(options: O): { kind: "receive" } & O {
	return { kind: "receive", ...options };
}

type ProtocolOf<D> = D extends StaticActorDeclaration<infer P, unknown, unknown> ? P : never;
type SendInputOptions<I> =
	| { input: ActorPlacement<I>; inputs?: never }
	| { input?: never; inputs: ActorPlacement<I[]> | readonly ActorPlacement<I>[] };

export function send<
	const D extends StaticActorDeclaration<ProtocolCst, unknown, unknown>,
	const M extends MessageTypes<ProtocolOf<D>>,
	const Target extends string,
>(options: { to: D; event: M; target: Target } & SendInputOptions<MessageInput<ProtocolOf<D>, M>>): SendStateCst & { target: Target } {
	return { kind: "send", ...options } as SendStateCst & { target: Target };
}

type CallRouting<P extends ProtocolCst, M extends keyof P, Target extends string = string> = P[M] extends {
	replies: infer R extends Record<string, SchemaCst>;
}
	? { target?: never; transitions: { [E in keyof R]: Target } }
	: { target: Target; transitions?: never };

export function call<
	const D extends StaticActorDeclaration<ProtocolCst, unknown, unknown>,
	const M extends MessageTypes<ProtocolOf<D>>,
	const Target extends string,
>(options: {
	to: D;
	event: M;
	input: ActorPlacement<MessageInput<ProtocolOf<D>, M>>;
} & CallRouting<ProtocolOf<D>, M, Target>): CallStateCst & CallRouting<ProtocolOf<D>, M, Target> & { readonly __result?: ReplyUnion<ProtocolOf<D>, M> } {
	return { kind: "call", ...options } as unknown as CallStateCst & CallRouting<ProtocolOf<D>, M, Target> & { readonly __result?: ReplyUnion<ProtocolOf<D>, M> };
}

export function reply<const O extends Omit<ReplyStateCst, "kind">>(options: O): { kind: "reply" } & O {
	return { kind: "reply", ...options };
}

export type TerminalOptions = Omit<FinalStateCst, "kind" | "outcome">;

/** A successful terminal state. final() with no options remains supported. */
export function final(options: TerminalOptions = {}): FinalStateCst {
	return { kind: "final", outcome: "complete", ...options };
}

/** An explicitly failed terminal state. Terminal names and incoming event names do not imply failure. */
export function failed(options: TerminalOptions = {}): FinalStateCst {
	return { kind: "final", outcome: "failed", ...options };
}

export function compound<const O extends Omit<CompoundStateCst, "kind">>(options: O): { kind: "compound" } & O {
	return { kind: "compound", ...options };
}

export function parallel<const O extends Omit<ParallelStateCst, "kind">>(options: O): { kind: "parallel" } & O {
	return { kind: "parallel", ...options };
}

export function map<const O extends Omit<MapStateCst, "kind">>(options: O): { kind: "map" } & O {
	return { kind: "map", ...options };
}

// Const type parameters throughout the DSL: the literal types of options (zod replies, artifact
// shapes, nested states) survive into the chart literal, so the typed layer can extract the
// registry from the definition itself.
export function agent<const O extends Omit<AgentActionCst, "kind" | "name">>(
	name: string,
	options: O = {} as O,
): { kind: "agent"; name: string } & O {
	return { kind: "agent", name, ...options };
}

export function user<const O extends Omit<UserActionCst, "kind">>(options: O): { kind: "user" } & O {
	return { kind: "user", ...options };
}

// Tagged template for parameter values: t`Report on ${arg("topic")} using ${result("plan", "dir")}`.
// Evaluates to plain data — the machine renders it right before dispatch. Ref interpolations
// must resolve to primitives (a ref known to hold an object is embedded explicitly via
// json(ref)); plain primitive interpolations are build-time constants and fold into the strings.
export function t<const Values extends readonly (InputRef<string | number | boolean> | string | number | boolean)[]>(
	strings: TemplateStringsArray,
	...values: Values
): TemplateCst & { readonly __actorRefs?: Values } {
	const parts: string[] = [strings[0] ?? ""];
	const refs: InputRef[] = [];
	values.forEach((value, index) => {
		const next = strings[index + 1] ?? "";
		if (typeof value === "object") {
			refs.push(value);
			parts.push(next);
		} else {
			parts[parts.length - 1] += String(value) + next;
		}
	});
	return { kind: "template", strings: parts, refs };
}

// Marks a ref whose value is embedded as JSON text — the only way an object enters a template,
// both in the types (t() rejects object-typed refs) and at runtime (the renderer throws on a
// non-primitive value without this mark).
export function json<V>(ref: InputRef<V>): InputRef<string> {
	return { ...ref, json: true } as InputRef<string>;
}

export function arg(name: string): InputRef {
	return { kind: "arg", name };
}

export function event(path?: string): EventBindingCst {
	return { kind: "event", ...(path === undefined ? {} : { path }) };
}

export function input<const Name extends string>(name: Name): InputRef<unknown> & ActorStateInputRefMarker<Name, undefined>;
export function input<const Name extends string, const Path extends string>(name: Name, path: Path): InputRef<unknown> & ActorStateInputRefMarker<Name, Path>;
export function input(name: string, path?: string): InputRef {
	return { kind: "input", name, ...(path === undefined ? {} : { path }) };
}

/** Immutable placement input of the current explicit actor. Selectors are checked by actor(). */
export function actorInput(): InputRef<unknown> & ActorInputRefMarker<undefined>;
export function actorInput<const Path extends string>(path: Path): InputRef<unknown> & ActorInputRefMarker<Path>;
export function actorInput(path?: string): InputRef {
	return { kind: "actorInput", ...(path === undefined ? {} : { path }) };
}

/** Input of the current mailbox message; actor() checks message and selector. */
export function messageInput<const Message extends string>(message: Message): InputRef<unknown> & ActorMessageInputRefMarker<Message, undefined>;
export function messageInput<const Message extends string, const Path extends string>(message: Message, path: Path): InputRef<unknown> & ActorMessageInputRefMarker<Message, Path>;
export function messageInput(message: string, path?: string): InputRef {
	return { kind: "messageInput", message, ...(path === undefined ? {} : { path }) };
}

export function visit(state?: string): InputRef<number> {
	return { kind: "visit", ...(state === undefined ? {} : { state }) };
}

export function resume(message: Templatable): OnReenterCst {
	return { kind: "resume", message };
}

// The instance key of the nearest enclosing map.
export function key(): InputRef<string> {
	return { kind: "key" };
}

// The spawn-pinned item of the nearest enclosing map instance, optionally a dot-path into it.
export function item(path?: string): InputRef {
	return { kind: "item", ...(path === undefined ? {} : { path }) };
}

export function result<const State extends string>(state: State): InputRef<unknown> & ActorResultRefMarker<State, undefined>;
export function result<const State extends string, const Path extends string>(state: State, path: Path): InputRef<unknown> & ActorResultRefMarker<State, Path>;
export function result(state: string, path?: string): InputRef {
	return { kind: "result", state, ...(path === undefined ? {} : { path }) };
}

// A deliverable file with an optional content shape — see ArtifactCst.
export function artifact<const P extends Templatable>(path: P): { kind: "artifact"; path: P };
export function artifact<const P extends Templatable, const S extends SchemaCst>(
	path: P,
	shape: S,
): { kind: "artifact"; path: P; shape: S };
export function artifact(path: Templatable, shape?: SchemaCst): ArtifactCst {
	return { kind: "artifact", path, ...(shape === undefined ? {} : { shape }) };
}

// Read an artifact another state declared: path and content shape come from the producer.
// `artifact` names which one (omit when the producer declares exactly one); `select` narrows the
// read to a dot-path field of the file's content.
export function artifactOf<const State extends string>(state: State): ArtifactOfCst & ActorArtifactRefMarker<State, undefined, undefined>;
export function artifactOf<const State extends string, const Options extends { artifact?: string; select?: string }>(state: State, opts: Options): ArtifactOfCst & ActorArtifactRefMarker<State, Options extends { artifact: infer Artifact extends string } ? Artifact : undefined, Options extends { select: infer Select extends string } ? Select : undefined>;
export function artifactOf(state: string, opts: { artifact?: string; select?: string } = {}): ArtifactOfCst {
	return {
		kind: "artifactOf",
		state,
		...(opts.artifact === undefined ? {} : { artifact: opts.artifact }),
		...(opts.select === undefined ? {} : { select: opts.select }),
	};
}

// A read of the named artifact of EVERY instance of the map enclosing `state` (a template
// path): agents get one file per instance, scripts a JSON array of paths.
export function joinArtifactOf(state: string, opts: { artifact?: string } = {}): JoinArtifactOfCst {
	return { kind: "joinArtifactOf", state, ...(opts.artifact === undefined ? {} : { artifact: opts.artifact }) };
}

export function tsImport(module: string, exportName: string): GuardRef {
	return { kind: "tsImport", module, export: exportName };
}

// Doubles as a guard (validate: script(...)) and as a command action (action: script(...)) —
// the position decides. Parameters flow through env templates; command/args stay static.
export function script<const O extends Omit<ScriptActionCst, "kind" | "command" | "args">>(
	command: string,
	args?: readonly string[],
	opts: O = {} as O,
): { kind: "script"; command: string; args?: readonly string[] } & O {
	return { kind: "script", command, ...(args === undefined ? {} : { args }), ...opts };
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		return value;
	}
	const object = value as object;
	if (seen.has(object)) return value;
	seen.add(object);
	for (const property of Reflect.ownKeys(object)) {
		const child = (object as Record<PropertyKey, unknown>)[property];
		deepFreeze(child, seen);
	}
	return Object.freeze(value);
}

export type { SchemaCst } from "./types.js";
export { contract } from "./schema_contract.js";
