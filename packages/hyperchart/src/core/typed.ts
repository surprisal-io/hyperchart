import type { z } from "zod";
import type {
	ActorForwardRef,
	AnyStaticActorDeclaration,
	ArtifactOfCst,
	ChartArgumentCst,
	ChartCst,
	CompletionContract,
	CompletionDeclarationCst,
	CompletionForwardRef,
	EventBindingCst,
	JoinArtifactOfCst,
	JoinResultOfCst,
	InferSchema,
	InputRef,
	ProtocolCst,
	ProtocolOf,
} from "./types.js";

// Dot-paths a result() selector may take into a value of type T. Free-form objects
// (Record<string, unknown>) admit any tail; arrays and primitives end the path.
export type Paths<T> = T extends readonly unknown[]
	? never
	: T extends object
		? { [K in keyof T & string]: K | `${K}.${Paths<NonNullable<T[K]>>}` }[keyof T & string]
		: never;

// The value type a dot-path selector extracts from T; anything unresolvable degrades to unknown.
export type ValueAt<T, P extends string> = P extends `${infer K}.${infer Rest}`
	? K extends keyof T
		? ValueAt<NonNullable<T[K]>, Rest>
		: unknown
	: P extends keyof T
		? T[P]
		: unknown;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

type Simplify2<T> = { [K in keyof T]: T[K] };

type JoinPath<Prefix extends string, K extends string> = Prefix extends "" ? K : `${Prefix}.${K}`;

// Flattens a chart's nested states into a union of [absolutePath, stateNode] pairs — the
// type-level twin of normalize's collectState.
type FlattenStates<S, Prefix extends string = ""> = {
	[K in keyof S & string]:
		| [JoinPath<Prefix, K>, S[K]]
		| (S[K] extends { states: infer Children } ? FlattenStates<Children, JoinPath<Prefix, K>> : never);
}[keyof S & string];

type InferSpec<S> = S extends z.ZodType ? z.infer<S> : unknown;

/** The run-argument registry inferred from chart-level argument schemas. */
export type ArgsOf<C> = C extends { args: infer A }
	? Simplify2<{
			[K in keyof A]: A[K] extends { schema: infer S } ? InferSpec<S> : A[K] extends { default: infer D } ? D : unknown;
		}>
	: never;

type DeclaredEmits<S> =
	FlattenStates<S> extends infer E ? (E extends [string, { emit: readonly (infer Emit)[] }] ? Emit : never) : never;

type EmitEvent<E> = E extends { event: infer Event extends string } ? Event : never;

type EmitPayload<E, Event extends string> = E extends unknown
	? E extends { event: Event; schema: infer Schema }
		? InferSchema<Schema>
		: E extends { event: Event }
			? unknown
			: never
	: never;

/** The domain-event registry declared by emit() entries across all action states. */
export type EmitsOf<C> = C extends { states: infer S }
	? Simplify2<{
			[Event in EmitEvent<DeclaredEmits<S>>]: EmitPayload<DeclaredEmits<S>, Event>;
		}>
	: never;

// The registry the chart itself declares: action replies and typed call/callBatch results.
export type ResultsOf<C> = C extends { states: infer S }
	? Simplify2<
			UnionToIntersection<
				FlattenStates<S> extends infer E
					? E extends [infer P extends string, { action: { kind: "waitFor"; __result?: infer R } }]
						? { [K in P]: R }
						: E extends [infer P extends string, { action: { reply: infer R } }]
							? { [K in P]: InferSpec<R> }
							: E extends [infer P extends string, { kind: "callBatch"; __result?: infer R }]
								? { [K in P]: R }
								: E extends [infer P extends string, { kind: "call"; __result?: infer R }]
									? { [K in P]: R }
									: never
					: never
			> &
				NonNullable<unknown> // intersection identity for the no-entries case
		>
	: never;

type ArtifactShapes<A> = Simplify2<{
	[N in keyof A]: A[N] extends { shape: infer S } ? InferSpec<S> : unknown;
}>;

type PresentArtifactMap<A> = [A] extends [never]
	? Record<never, never>
	: [A] extends [Record<string, unknown>]
		? A
		: Record<never, never>;

type ActionAndGuardArtifacts<A, G> = PresentArtifactMap<A> & PresentArtifactMap<G>;

// The file registry the chart itself declares: every artifact-declaring state, artifact name →
// content type (unknown when no shape is declared).
export type FilesOf<C> = C extends { states: infer S }
	? Simplify2<
			UnionToIntersection<
				FlattenStates<S> extends infer E
					? E extends [
							infer P extends string,
							{ action: { artifacts: infer A; validation?: { guard: { kind: "script"; artifacts?: infer G } } } },
						]
						? { [K in P]: ArtifactShapes<ActionAndGuardArtifacts<A, G>> }
						: E extends [infer P extends string, { action: { artifacts: infer A } }]
							? { [K in P]: ArtifactShapes<ActionAndGuardArtifacts<A, never>> }
							: E extends [infer P extends string, { action: { validation: { guard: infer V } } }]
								? V extends { artifacts: infer G }
									? { [K in P]: ArtifactShapes<ActionAndGuardArtifacts<never, G>> }
									: never
								: never
					: never
			> &
				NonNullable<unknown> // intersection identity for the no-entries case
		>
	: never;

// The value type an InputRef resolves to, recovered from its __value phantom.
type RefValue<R> = R extends { __value?(value: infer V): void } ? V : unknown;

// The per-instance item type of a map's `over` value: array element or record value.
type ItemOf<V> = V extends readonly (infer E)[] ? E : V extends Record<string, infer E> ? E : unknown;

// The map registry the chart itself declares: every map state, template path → the item type its
// instances are spawned with (carried by the phantom of the `over` ref).
export type MapsOf<C> = C extends { states: infer S }
	? Simplify2<
			UnionToIntersection<
				FlattenStates<S> extends infer E
					? E extends [infer P extends string, { kind: "map"; over: infer R }]
						? { [K in P]: ItemOf<RefValue<R>> }
						: never
					: never
			> &
				NonNullable<unknown> // intersection identity for the no-entries case
		>
	: never;

type InputShapes<I> = Simplify2<{
	[N in keyof I]: InferSpec<I[N]>;
}>;

// The input registry the chart itself declares: every input-declaring state/map,
// state path → input name → value type.
export type InputsOf<C> = C extends { states: infer S }
	? Simplify2<
			UnionToIntersection<
				FlattenStates<S> extends infer E
					? E extends [infer P extends string, { kind: "state" | "map"; input: infer I }]
						? { [K in P]: InputShapes<I> }
						: never
					: never
			> &
				NonNullable<unknown> // intersection identity for the no-entries case
		>
	: never;

type ActorProtocols<A> =
	A extends Record<string, unknown>
		? {
				[K in keyof A & string]: A[K] extends AnyStaticActorDeclaration ? ProtocolOf<A[K]> : never;
			}
		: never;

/** The actor protocol registry declared by all static actor bindings in a chart. */
export type ActorsOf<C> = C extends { states: infer S }
	? Simplify2<
			UnionToIntersection<
				| (C extends { actors: infer A } ? ActorProtocols<A> : never)
				| (FlattenStates<S> extends infer E
						? E extends [string, { actors: infer A }]
							? ActorProtocols<A>
							: never
						: never)
			> &
				NonNullable<unknown>
		>
	: never;

type CompletionContracts<D> =
	D extends Record<string, unknown>
		? {
				[K in keyof D & string]: D[K] extends CompletionDeclarationCst<infer S, infer Event>
					? CompletionContract<Event, InferSchema<S>>
					: never;
			}
		: never;

/** The completion contract registry declared by root chart endpoints. */
export type CompletionsOf<C> = C extends { completions: infer D }
	? Simplify2<CompletionContracts<D>>
	: Record<never, never>;

// Both directions must hold: everything the registry declares exists in the chart with the same
// type, and everything the chart declares is written down in the registry.
type Mutual<Declared, Actual, Message extends string> = [Declared] extends [Actual]
	? [Actual] extends [Declared]
		? unknown
		: { [K in Message]: { chartDeclares: Actual; registryDeclares: Declared } }
	: { [K in Message]: { chartDeclares: Actual; registryDeclares: Declared } };

type ArgumentMetadataFor<Args> = Partial<{
	[K in keyof Args & string]: Omit<ChartArgumentCst, "default" | "schema"> & {
		default?: Args[K];
		schema?: z.ZodType<Args[K]>;
	};
}>;

type VerifyArguments<C, Args> = C extends { args: infer Actual }
	? Actual extends ArgumentMetadataFor<Args>
		? Exclude<keyof Actual, keyof Args> extends never
			? unknown
			: { "chart argument metadata names an unknown Args key": { chartDeclares: Actual; registryDeclares: Args } }
		: {
				"chart argument metadata is out of sync with the Args registry": {
					chartDeclares: Actual;
					registryDeclares: Args;
				};
			}
	: unknown;

type ActorRegistry = Record<string, ProtocolCst>;
type UncheckedActorRegistry = { readonly __hyperchartUncheckedActors: true };
type CompletionRegistry = Record<string, CompletionContract>;
type UncheckedCompletionRegistry = { readonly __hyperchartUncheckedCompletions: true };

type VerifyActors<C, Actors> = Actors extends ActorRegistry
	? Mutual<Actors, ActorsOf<C>, "actors registry is out of sync with the chart">
	: unknown;

type VerifyCompletions<C, Completions> = Completions extends CompletionRegistry
	? Mutual<Completions, CompletionsOf<C>, "completions registry is out of sync with the chart">
	: unknown;

type VerifyDecl<C, Args, Results, Files, Maps, Inputs, Actors, Completions> = VerifyArguments<C, Args> &
	Mutual<Results, ResultsOf<C>, "results registry is out of sync with the chart"> &
	Mutual<Files, FilesOf<C>, "files registry is out of sync with the chart"> &
	Mutual<Maps, MapsOf<C>, "maps registry is out of sync with the chart"> &
	Mutual<Inputs, InputsOf<C>, "inputs registry is out of sync with the chart"> &
	VerifyActors<C, Actors> &
	VerifyCompletions<C, Completions>;

type InputNames<Inputs> = {
	[S in keyof Inputs]: keyof Inputs[S];
}[keyof Inputs] &
	string;

type InputValue<Inputs, K extends string> = {
	[S in keyof Inputs]: K extends keyof Inputs[S] ? Inputs[S][K] : never;
}[keyof Inputs];

type Refs<Args, Results, Files, Maps, Inputs, Actors, Completions> = {
	// The checking chart constructor: accepts only a literal whose declared replies/artifacts
	// match the registry the refs were built from — the registry cannot drift from the chart.
	chart: <const C extends ChartCst>(
		def: C & VerifyDecl<C, Args, Results, Files, Maps, Inputs, Actors, Completions>,
	) => C;
	actorRef: Actors extends ActorRegistry
		? <K extends keyof Actors & string>(name: K) => ActorForwardRef<Actors[K], K>
		: (name: never) => never;
	completionRef: Completions extends CompletionRegistry
		? <K extends keyof Completions & string>(name: K) => CompletionForwardRef<Completions[K], K>
		: (name: never) => never;
	arg: <K extends keyof Args & string>(name: K) => InputRef<Args[K]>;
	event: (path?: string) => EventBindingCst;
	visit: (state?: string) => InputRef<number>;
	input: {
		<K extends InputNames<Inputs>>(name: K): InputRef<InputValue<Inputs, K>>;
		<K extends InputNames<Inputs>, P extends Paths<InputValue<Inputs, K>> & string>(
			name: K,
			path: P,
		): InputRef<ValueAt<InputValue<Inputs, K>, P>>;
	};
	result: {
		<S extends keyof Results & string>(state: S): InputRef<Results[S]>;
		<S extends keyof Results & string, P extends Paths<Results[S]> & string>(
			state: S,
			path: P,
		): InputRef<ValueAt<Results[S], P>>;
	};
	artifactOf: {
		<S extends keyof Files & string>(state: S): ArtifactOfCst;
		<S extends keyof Files & string, A extends keyof Files[S] & string>(
			state: S,
			opts: { artifact: A; select?: Paths<Files[S][A]> & string },
		): ArtifactOfCst;
		// single-artifact convenience: select checked against the (union of) content types
		<S extends keyof Files & string>(
			state: S,
			opts: { select: Paths<Files[S][keyof Files[S]]> & string },
		): ArtifactOfCst;
	};
	joinArtifactOf: {
		<S extends keyof Files & string>(state: S): JoinArtifactOfCst;
		<S extends keyof Files & string, A extends keyof Files[S] & string>(
			state: S,
			opts: { artifact: A },
		): JoinArtifactOfCst;
	};
	joinResultOf: {
		<S extends keyof Results & string>(state: S): JoinResultOfCst;
		<S extends keyof Results & string, P extends Paths<Results[S]> & string>(
			state: S,
			opts: { path: P },
		): JoinResultOfCst;
	};
	// The instance args of the named map (its template path — the registry key): the key is
	// always a string, the item type comes from the registry and is verified against `over`.
	key: <M extends keyof Maps & string>(map: M) => InputRef<string>;
	item: {
		<M extends keyof Maps & string>(map: M): InputRef<Maps[M]>;
		<M extends keyof Maps & string, P extends Paths<Maps[M]> & string>(map: M, path: P): InputRef<ValueAt<Maps[M], P>>;
	};
};

// Typed refs, TS-first: Args is the shape of the run's arguments, Results maps state paths to
// the TS types of their event payloads (their RESULTS), Files maps artifact-producing state
// paths to maps of artifact name → the TS type of that file's CONTENT — plain TS types are the
// source of truth (inferred from the zod values the
// chart exports, when zod is used). Purely compile-time: arg names, state keys, path selectors
// and the value types flowing into templates are checked as you type; runtime enforcement rides
// the schema refs. Consistency of the keys with real chart states stays normalize's job
// (UNKNOWN_INPUT_RESULT / UNKNOWN_FILE_SOURCE).
type BoundRefMetadata = Readonly<{ binding: object; name: string }>;
type BoundRefMetadataRegistry = Readonly<{
	actorRefs: WeakMap<object, BoundRefMetadata>;
	completionRefs: WeakMap<object, BoundRefMetadata>;
	charts: WeakMap<object, object>;
}>;

// Jiti loads an external chart's aliased package entry as a second module instance, while the
// host normalizer remains in the first. Keep opaque provenance in process-local WeakMaps shared
// by those instances; refs and chart bindings remain identity-based, non-serializable capabilities.
const BOUND_REF_METADATA_KEY = Symbol.for("@surprisal/hyperchart/typed-ref-metadata/v1");

function isBoundRefMetadataRegistry(value: unknown): value is BoundRefMetadataRegistry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<BoundRefMetadataRegistry>;
	return (
		candidate.actorRefs instanceof WeakMap &&
		candidate.completionRefs instanceof WeakMap &&
		candidate.charts instanceof WeakMap
	);
}

function sharedBoundRefMetadataRegistry(): BoundRefMetadataRegistry {
	const existing: unknown = Reflect.get(globalThis, BOUND_REF_METADATA_KEY);
	if (existing !== undefined) {
		if (!isBoundRefMetadataRegistry(existing)) {
			throw new Error("Hyperchart typed-ref metadata registry is invalid");
		}
		return existing;
	}
	const registry = Object.freeze({
		actorRefs: new WeakMap<object, BoundRefMetadata>(),
		completionRefs: new WeakMap<object, BoundRefMetadata>(),
		charts: new WeakMap<object, object>(),
	});
	Object.defineProperty(globalThis, BOUND_REF_METADATA_KEY, {
		configurable: false,
		enumerable: false,
		value: registry,
		writable: false,
	});
	return registry;
}

const sharedBoundRefMetadata = sharedBoundRefMetadataRegistry();
const actorRefMetadata = sharedBoundRefMetadata.actorRefs;
const completionRefMetadata = sharedBoundRefMetadata.completionRefs;
const chartActorRefBindings = sharedBoundRefMetadata.charts;

/** @internal Authoring metadata used only while normalizing a refs()-bound chart. */
export function getActorRefMetadata(value: object): BoundRefMetadata | undefined {
	return actorRefMetadata.get(value);
}

/** @internal Authoring metadata used only while normalizing a refs()-bound chart. */
export function getCompletionRefMetadata(value: object): BoundRefMetadata | undefined {
	return completionRefMetadata.get(value);
}

/** @internal Authoring metadata used only while normalizing a refs()-bound chart. */
export function getChartActorRefBinding(value: object): object | undefined {
	return chartActorRefBindings.get(value);
}

export function refs<
	Args extends Record<string, unknown>,
	Results extends Record<string, unknown>,
	Files extends Record<string, Record<string, unknown>> = Record<never, Record<string, unknown>>,
	Maps extends Record<string, unknown> = Record<never, unknown>,
	Inputs extends Record<string, Record<string, unknown>> = Record<never, Record<string, unknown>>,
	Actors extends ActorRegistry | UncheckedActorRegistry = UncheckedActorRegistry,
	Completions extends CompletionRegistry | UncheckedCompletionRegistry = UncheckedCompletionRegistry,
>(): Refs<Args, Results, Files, Maps, Inputs, Actors, Completions> {
	const binding = Object.freeze({});
	return {
		chart: (def) => {
			chartActorRefBindings.set(def, binding);
			return def;
		},
		actorRef: ((name: string) => {
			const ref = Object.freeze({ kind: "actorRef" as const, name });
			actorRefMetadata.set(ref, Object.freeze({ binding, name }));
			return ref;
		}) as Refs<Args, Results, Files, Maps, Inputs, Actors, Completions>["actorRef"],
		completionRef: ((name: string) => {
			const ref = Object.freeze({ kind: "completionRef" as const, name });
			completionRefMetadata.set(ref, Object.freeze({ binding, name }));
			return ref;
		}) as Refs<Args, Results, Files, Maps, Inputs, Actors, Completions>["completionRef"],
		arg: (name) => ({ kind: "arg", name }),
		event: (path?: string) => ({ kind: "event", ...(path === undefined ? {} : { path }) }),
		visit: (state?: string) => ({ kind: "visit", ...(state === undefined ? {} : { state }) }),
		input: ((name: string, path?: string) => ({
			kind: "input",
			name,
			...(path === undefined ? {} : { path }),
		})) as Refs<Args, Results, Files, Maps, Inputs, Actors, Completions>["input"],
		result: ((state: string, path?: string) => ({
			kind: "result",
			state,
			...(path === undefined ? {} : { path }),
		})) as Refs<Args, Results, Files, Maps, Inputs, Actors, Completions>["result"],
		artifactOf: ((state: string, opts: { artifact?: string; select?: string } = {}) => ({
			kind: "artifactOf",
			state,
			...(opts.artifact === undefined ? {} : { artifact: opts.artifact }),
			...(opts.select === undefined ? {} : { select: opts.select }),
		})) as Refs<Args, Results, Files, Maps, Inputs, Actors, Completions>["artifactOf"],
		joinArtifactOf: ((state: string, opts: { artifact?: string } = {}) => ({
			kind: "joinArtifactOf",
			state,
			...(opts.artifact === undefined ? {} : { artifact: opts.artifact }),
		})) as Refs<Args, Results, Files, Maps, Inputs, Actors, Completions>["joinArtifactOf"],
		joinResultOf: ((state: string, opts: { path?: string } = {}) => ({
			kind: "joinResultOf",
			state,
			...(opts.path === undefined ? {} : { path: opts.path }),
		})) as Refs<Args, Results, Files, Maps, Inputs, Actors, Completions>["joinResultOf"],
		key: (map) => ({ kind: "key", map }),
		item: ((map: string, path?: string) => ({
			kind: "item",
			map,
			...(path === undefined ? {} : { path }),
		})) as Refs<Args, Results, Files, Maps, Inputs, Actors, Completions>["item"],
	};
}
