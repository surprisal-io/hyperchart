import type { z } from "zod";
import type { ArtifactOfCst, ChartCst, JoinArtifactOfCst, InputRef } from "./types.js";

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

// The registry the chart itself declares: every state whose action has a zod (or other) reply.
export type ResultsOf<C> = C extends { states: infer S }
	? Simplify2<
			UnionToIntersection<
				FlattenStates<S> extends infer E
					? E extends [infer P extends string, { action: { reply: infer R } }]
						? { [K in P]: InferSpec<R> }
						: never
					: never
			> &
				NonNullable<unknown> // intersection identity for the no-entries case
		>
	: never;

type ArtifactShapes<A> = Simplify2<{
	[N in keyof A]: A[N] extends { shape: infer S } ? InferSpec<S> : unknown;
}>;

// The file registry the chart itself declares: every artifact-declaring state, artifact name →
// content type (unknown when no shape is declared).
export type FilesOf<C> = C extends { states: infer S }
	? Simplify2<
			UnionToIntersection<
				FlattenStates<S> extends infer E
					? E extends [infer P extends string, { action: { artifacts: infer A } }]
						? { [K in P]: ArtifactShapes<A> }
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

// Both directions must hold: everything the registry declares exists in the chart with the same
// type, and everything the chart declares is written down in the registry.
type Mutual<Declared, Actual, Message extends string> = [Declared] extends [Actual]
	? [Actual] extends [Declared]
		? unknown
		: { [K in Message]: { chartDeclares: Actual; registryDeclares: Declared } }
	: { [K in Message]: { chartDeclares: Actual; registryDeclares: Declared } };

type VerifyDecl<C, Results, Files, Maps> = Mutual<
	Results,
	ResultsOf<C>,
	"results registry is out of sync with the chart"
> &
	Mutual<Files, FilesOf<C>, "files registry is out of sync with the chart"> &
	Mutual<Maps, MapsOf<C>, "maps registry is out of sync with the chart">;

type Refs<Args, Results, Files, Maps> = {
	// The checking chart constructor: accepts only a literal whose declared replies/artifacts
	// match the registry the refs were built from — the registry cannot drift from the chart.
	chart: <const C extends ChartCst>(def: C & VerifyDecl<C, Results, Files, Maps>) => C;
	arg: <K extends keyof Args & string>(name: K) => InputRef<Args[K]>;
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
export function refs<
	Args extends Record<string, unknown>,
	Results extends Record<string, unknown>,
	Files extends Record<string, Record<string, unknown>> = Record<never, Record<string, unknown>>,
	Maps extends Record<string, unknown> = Record<never, unknown>,
>(): Refs<Args, Results, Files, Maps> {
	return {
		chart: (def) => def,
		arg: (name) => ({ kind: "arg", name }),
		result: ((state: string, path?: string) => ({
			kind: "result",
			state,
			...(path === undefined ? {} : { path }),
		})) as Refs<Args, Results, Files, Maps>["result"],
		artifactOf: ((state: string, opts: { artifact?: string; select?: string } = {}) => ({
			kind: "artifactOf",
			state,
			...(opts.artifact === undefined ? {} : { artifact: opts.artifact }),
			...(opts.select === undefined ? {} : { select: opts.select }),
		})) as Refs<Args, Results, Files, Maps>["artifactOf"],
		joinArtifactOf: ((state: string, opts: { artifact?: string } = {}) => ({
			kind: "joinArtifactOf",
			state,
			...(opts.artifact === undefined ? {} : { artifact: opts.artifact }),
		})) as Refs<Args, Results, Files, Maps>["joinArtifactOf"],
		key: (map) => ({ kind: "key", map }),
		item: ((map: string, path?: string) => ({
			kind: "item",
			map,
			...(path === undefined ? {} : { path }),
		})) as Refs<Args, Results, Files, Maps>["item"],
	};
}
