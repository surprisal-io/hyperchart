import type {
	ActorArtifactRefMarker,
	ActorInputRefMarker,
	ActorMessageInputRefMarker,
	ActorResultRefMarker,
	ActorStateInputRefMarker,
	ActorPlacement,
	ActorTemplate,
	ActorVerification,
	CallRouting,
	InferSchema,
	MessageInput,
	MessageTypes,
	ProtocolOf,
	ReplyEvents,
	ReplyOutput,
	ReplyUnion,
	SendInputOptions,
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

export function send<
	const D extends StaticActorDeclaration<ProtocolCst, unknown, unknown>,
	const M extends MessageTypes<ProtocolOf<D>>,
	const Target extends string,
>(options: { to: D; event: M; target: Target } & SendInputOptions<MessageInput<ProtocolOf<D>, M>>): SendStateCst & { target: Target } {
	return { kind: "send", ...options } as SendStateCst & { target: Target };
}

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
