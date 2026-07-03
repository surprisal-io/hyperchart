import type { ArtifactOfCst, InputRef } from "./types.js";

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

type Refs<Args, Results, Files> = {
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
>(): Refs<Args, Results, Files> {
	return {
		arg: (name) => ({ kind: "arg", name }),
		result: ((state: string, path?: string) => ({
			kind: "result",
			state,
			...(path === undefined ? {} : { path }),
		})) as Refs<Args, Results, Files>["result"],
		artifactOf: ((state: string, opts: { artifact?: string; select?: string } = {}) => ({
			kind: "artifactOf",
			state,
			...(opts.artifact === undefined ? {} : { artifact: opts.artifact }),
			...(opts.select === undefined ? {} : { select: opts.select }),
		})) as Refs<Args, Results, Files>["artifactOf"],
	};
}
