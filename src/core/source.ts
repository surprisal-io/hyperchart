import type {
	ArtifactAst,
	ArtifactOfAst,
	ChartAst,
	EventBindingAst,
	GuardRef,
	InputRef,
	JoinArtifactOfAst,
	JsonSchema,
	OnReenterAst,
	SchemaAst,
	StateActionAst,
	StatePath,
	TemplateAst,
	TransitionAst,
} from "./types.js";

const DSL_INDENT = "\t";

export function hyperchartSource(ast: ChartAst, selectedStateId: StatePath | null = null): string {
	if (selectedStateId === null) return `chart(${chartDsl(ast)})`;
	const state = ast.states[selectedStateId];
	if (state === undefined) return "undefined";
	return `${objectKeyDsl(state.id)}: ${stateDsl(ast, selectedStateId)}`;
}

export function hyperchartStateSources(ast: ChartAst): Record<StatePath, string> {
	return Object.fromEntries(Object.keys(ast.states).map((path) => [path, hyperchartSource(ast, path)]));
}

function childStatePaths(ast: ChartAst, parent: StatePath | undefined): StatePath[] {
	return Object.entries(ast.states).flatMap(([path, state]) => (state.parent === parent ? [path] : []));
}

function indentDslValue(value: string): string {
	return value.replace(/\n/g, `\n${DSL_INDENT}`);
}

function objectKeyDsl(key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function stringDsl(value: string): string {
	if (value.includes("\n")) return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
	return JSON.stringify(value);
}

function objectDsl(entries: Array<[string, string | undefined]>): string {
	const present = entries.filter((entry): entry is [string, string] => entry[1] !== undefined);
	if (present.length === 0) return "{}";
	return `{\n${present.map(([key, value]) => `${DSL_INDENT}${objectKeyDsl(key)}: ${indentDslValue(value)},`).join("\n")}\n}`;
}

function arrayDsl(values: string[]): string {
	if (values.length === 0) return "[]";
	const inline = `[${values.join(", ")}]`;
	if (!values.some((value) => value.includes("\n")) && inline.length <= 100) return inline;
	return `[\n${values.map((value) => `${DSL_INDENT}${indentDslValue(value)},`).join("\n")}\n]`;
}

function chartDsl(ast: ChartAst): string {
	return objectDsl([
		["kind", stringDsl("chart")],
		["id", stringDsl(ast.id)],
		["initial", stringDsl(ast.initial)],
		["states", statesDsl(ast, undefined)],
	]);
}

function statesDsl(ast: ChartAst, parent: StatePath | undefined): string {
	return objectDsl(childStatePaths(ast, parent).map((path) => [ast.states[path]?.id ?? path, stateDsl(ast, path)]));
}

function stateDsl(ast: ChartAst, path: StatePath): string {
	const state = ast.states[path];
	if (state === undefined) return "undefined";
	if (state.kind === "final") return "final()";
	if (state.kind === "state") {
		return objectDsl([
			["kind", stringDsl("state")],
			["input", schemaRecordDsl(state.input)],
			["action", actionDsl(state.action)],
			["transitions", transitionsDsl(state.transitions)],
			[
				"after",
				state.after === undefined
					? undefined
					: objectDsl([
							["delayMs", String(state.after.delayMs)],
							["target", stringDsl(state.after.target)],
						]),
			],
			["validate", state.validate === undefined ? undefined : guardDsl(state.validate)],
			["onReject", state.onReject === undefined ? undefined : stringDsl(state.onReject)],
			["onReenter", onReenterDsl(state.onReenter)],
			["retries", state.retries === undefined ? undefined : String(state.retries)],
		]);
	}
	if (state.kind === "map") {
		return `map(${objectDsl([
			["input", schemaRecordDsl(state.input)],
			["over", inputRefDsl(state.over)],
			["concurrency", state.concurrency === undefined ? undefined : String(state.concurrency)],
			["onReenter", onReenterDsl(state.onReenter)],
			["initial", stringDsl(state.initial)],
			["states", statesDsl(ast, path)],
			["transitions", transitionsDsl(state.transitions)],
			["onDone", stringDsl(state.onDone)],
		])})`;
	}
	if (state.kind === "parallel") {
		return `parallel(${objectDsl([
			["states", statesDsl(ast, path)],
			["transitions", transitionsDsl(state.transitions)],
			["onDone", stringDsl(state.onDone)],
		])})`;
	}
	return `compound(${objectDsl([
		["initial", stringDsl(state.initial)],
		["states", statesDsl(ast, path)],
		["transitions", transitionsDsl(state.transitions)],
		...(state.kind === "compound"
			? ([["onDone", stringDsl(state.onDone)]] as Array<[string, string | undefined]>)
			: []),
	])})`;
}

function actionDsl(action: StateActionAst): string {
	if (action.kind === "agent") {
		const options = objectDsl([
			["task", templateDsl(action.task)],
			["artifacts", artifactsDsl(action.artifacts)],
			["reads", readsDsl(action.reads)],
			["model", action.model === undefined ? undefined : stringDsl(action.model)],
			["thinking", action.thinking === undefined ? undefined : stringDsl(action.thinking)],
			["tools", action.tools === undefined ? undefined : arrayDsl(action.tools.map(stringDsl))],
			["reply", action.reply === undefined ? undefined : schemaDsl(action.reply)],
		]);
		return options === "{}" ? `agent(${stringDsl(action.name)})` : `agent(${stringDsl(action.name)}, ${options})`;
	}
	if (action.kind === "script") return scriptDsl(action);
	return `user(${objectDsl([
		["prompt", templateDsl(action.prompt)],
		["options", action.options.length === 0 ? undefined : arrayDsl(action.options.map(stringDsl))],
		["reply", action.reply === undefined ? undefined : schemaDsl(action.reply)],
	])})`;
}

function scriptDsl(value: Extract<StateActionAst, { kind: "script" }> | Extract<GuardRef, { kind: "script" }>): string {
	const args = "args" in value && value.args.length > 0 ? value.args : undefined;
	const options =
		"uid" in value
			? objectDsl([
					["env", envDsl(value.env)],
					["artifacts", artifactsDsl(value.artifacts)],
					["reply", value.reply === undefined ? undefined : schemaDsl(value.reply)],
				])
			: "{}";
	const callArgs = [
		stringDsl(value.command),
		...(args === undefined ? (options === "{}" ? [] : ["[]"]) : [arrayDsl(args.map(stringDsl))]),
		...(options === "{}" ? [] : [options]),
	];
	return `script(${callArgs.join(", ")})`;
}

function guardDsl(value: GuardRef): string {
	if (value.kind === "script") return scriptDsl(value);
	return `tsImport(${stringDsl(value.module)}, ${stringDsl(value.export)})`;
}

function transitionsDsl(transitions: Readonly<Record<string, TransitionAst>>): string | undefined {
	const entries = Object.entries(transitions);
	if (entries.length === 0) return undefined;
	return objectDsl(entries.map(([eventType, transition]) => [eventType, transitionDsl(transition)]));
}

function transitionDsl(transition: TransitionAst): string {
	if (transition.input === undefined || Object.keys(transition.input).length === 0) return stringDsl(transition.target);
	return objectDsl([
		["target", stringDsl(transition.target)],
		["input", eventBindingsDsl(transition.input)],
	]);
}

function eventBindingsDsl(input: Readonly<Record<string, EventBindingAst>>): string {
	return objectDsl(
		Object.entries(input).map(([name, binding]) => [
			name,
			binding.path === undefined ? "event()" : `event(${stringDsl(binding.path)})`,
		]),
	);
}

function onReenterDsl(value: OnReenterAst | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (value === "restart") return stringDsl("restart");
	return `resume(${templateDsl(value.message)})`;
}

function templateDsl(value: TemplateAst | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (value.refs.length === 0) return stringDsl(value.strings.join(""));
	const chunks = value.strings.map((chunk) =>
		chunk.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"),
	);
	return `t\`${chunks.reduce((acc, chunk, index) => {
		const ref = value.refs[index];
		return ref === undefined ? `${acc}${chunk}` : `${acc}${chunk}\${${inputRefDsl(ref)}}`;
	}, "")}\``;
}

function inputRefDsl(ref: InputRef): string {
	const rendered = inputRefDslBase(ref);
	return ref.json === true ? `json(${rendered})` : rendered;
}

function inputRefDslBase(ref: InputRef): string {
	switch (ref.kind) {
		case "arg":
			return `arg(${stringDsl(ref.name)})`;
		case "result":
			return ref.path === undefined
				? `result(${stringDsl(ref.state)})`
				: `result(${stringDsl(ref.state)}, ${stringDsl(ref.path)})`;
		case "input":
			return ref.path === undefined
				? `input(${stringDsl(ref.name)})`
				: `input(${stringDsl(ref.name)}, ${stringDsl(ref.path)})`;
		case "visit":
			return ref.state === undefined ? "visit()" : `visit(${stringDsl(ref.state)})`;
		case "key":
			return ref.map === undefined ? "key()" : `key(${stringDsl(ref.map)})`;
		case "item":
			if (ref.map !== undefined)
				return ref.path === undefined
					? `item(${stringDsl(ref.map)})`
					: `item(${stringDsl(ref.map)}, ${stringDsl(ref.path)})`;
			return ref.path === undefined ? "item()" : `item(${stringDsl(ref.path)})`;
	}
}

function schemaRecordDsl(input: Readonly<Record<string, SchemaAst>> | undefined): string | undefined {
	if (input === undefined || Object.keys(input).length === 0) return undefined;
	return objectDsl(Object.entries(input).map(([name, schema]) => [name, schemaDsl(schema)]));
}

function schemaDsl(schema: SchemaAst): string {
	return jsonSchemaDsl(schema.schema);
}

const SCHEMA_ANNOTATION_KEYS = new Set([
	"$id",
	"$schema",
	"title",
	"description",
	"default",
	"deprecated",
	"readOnly",
	"writeOnly",
	"examples",
]);

function jsonSchemaDsl(schema: Readonly<JsonSchema>): string {
	if (Array.isArray(schema.enum)) {
		const enumValues = schema.enum;
		const value = enumValues.every((item) => typeof item === "string")
			? `z.enum(${arrayDsl(enumValues.map((item) => stringDsl(String(item))))})`
			: `z.union(${arrayDsl(enumValues.map((item) => `z.literal(${JSON.stringify(item)})`))})`;
		return withSchemaMetadata(schema, value, new Set(["enum"]));
	}
	if ("const" in schema) {
		return withSchemaMetadata(schema, `z.literal(${JSON.stringify(schema.const)})`, new Set(["const"]));
	}
	if (Array.isArray(schema.anyOf)) {
		const value = `z.union(${arrayDsl(schema.anyOf.map((item) => jsonSchemaDsl(item as JsonSchema)))})`;
		return withSchemaMetadata(schema, value, new Set(["anyOf"]));
	}
	if (Array.isArray(schema.oneOf)) {
		const value = `z.union(${arrayDsl(schema.oneOf.map((item) => jsonSchemaDsl(item as JsonSchema)))})`;
		return withSchemaMetadata(schema, value, new Set(["oneOf"]));
	}
	if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
		const members = schema.allOf.map((item) => jsonSchemaDsl(item as JsonSchema));
		const value = members
			.slice(1)
			.reduce((left, right) => `z.intersection(${left}, ${right})`, members[0] ?? "z.any()");
		return withSchemaMetadata(schema, value, new Set(["allOf"]));
	}
	if (Array.isArray(schema.type) && schema.type.length > 0) {
		const members = schema.type.map((type) => jsonSchemaDsl({ ...schema, type, default: undefined }));
		return withSchemaMetadata(schema, `z.union(${arrayDsl(members)})`, new Set(["type"]));
	}
	if (schema.type === "string") return stringSchemaDsl(schema);
	if (schema.type === "integer") return numberSchemaDsl(schema, true);
	if (schema.type === "number") return numberSchemaDsl(schema, false);
	if (schema.type === "boolean") return withSchemaMetadata(schema, "z.boolean()", new Set(["type"]));
	if (schema.type === "null") return withSchemaMetadata(schema, "z.null()", new Set(["type"]));
	if (schema.type === "array") return arraySchemaDsl(schema);
	if (schema.type === "object" || schema.properties !== undefined || schema.additionalProperties !== undefined) {
		return objectSchemaDsl(schema);
	}
	return withSchemaMetadata(schema, "z.any()", new Set());
}

function stringSchemaDsl(schema: Readonly<JsonSchema>): string {
	let value = "z.string()";
	const supported = new Set(["type"]);
	if (typeof schema.minLength === "number") {
		value += `.min(${schema.minLength})`;
		supported.add("minLength");
	}
	if (typeof schema.maxLength === "number") {
		value += `.max(${schema.maxLength})`;
		supported.add("maxLength");
	}
	if (typeof schema.pattern === "string") {
		value += `.regex(new RegExp(${stringDsl(schema.pattern)}))`;
		supported.add("pattern");
	}
	if (typeof schema.format === "string") {
		const formatMethod: Record<string, string> = {
			email: "email",
			uri: "url",
			uuid: "uuid",
			"date-time": "datetime",
			date: "date",
			time: "time",
		};
		const method = formatMethod[schema.format];
		if (method !== undefined) {
			value += `.${method}()`;
			supported.add("format");
		}
	}
	return withSchemaMetadata(schema, value, supported);
}

function numberSchemaDsl(schema: Readonly<JsonSchema>, integer: boolean): string {
	let value = integer ? "z.number().int()" : "z.number()";
	const supported = new Set(["type"]);
	const exclusiveMinimum = schema.exclusiveMinimum;
	const exclusiveMaximum = schema.exclusiveMaximum;
	if (typeof exclusiveMinimum === "number") {
		value += `.gt(${exclusiveMinimum})`;
		supported.add("exclusiveMinimum");
	} else if (typeof schema.minimum === "number") {
		value += exclusiveMinimum === true ? `.gt(${schema.minimum})` : `.min(${schema.minimum})`;
		supported.add("minimum");
		if (typeof exclusiveMinimum === "boolean") supported.add("exclusiveMinimum");
	}
	if (typeof exclusiveMaximum === "number") {
		value += `.lt(${exclusiveMaximum})`;
		supported.add("exclusiveMaximum");
	} else if (typeof schema.maximum === "number") {
		value += exclusiveMaximum === true ? `.lt(${schema.maximum})` : `.max(${schema.maximum})`;
		supported.add("maximum");
		if (typeof exclusiveMaximum === "boolean") supported.add("exclusiveMaximum");
	}
	if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
		value += `.multipleOf(${schema.multipleOf})`;
		supported.add("multipleOf");
	}
	return withSchemaMetadata(schema, value, supported);
}

function arraySchemaDsl(schema: Readonly<JsonSchema>): string {
	const tupleItems = Array.isArray(schema.prefixItems)
		? schema.prefixItems
		: Array.isArray(schema.items)
			? schema.items
			: undefined;
	let value =
		tupleItems === undefined
			? `z.array(${jsonSchemaDsl((schema.items as JsonSchema | undefined) ?? {})})`
			: `z.tuple(${arrayDsl(tupleItems.map((item) => jsonSchemaDsl(item as JsonSchema)))})`;
	const supported = new Set(["type", tupleItems === schema.prefixItems ? "prefixItems" : "items"]);
	if (typeof schema.minItems === "number") {
		value += `.min(${schema.minItems})`;
		supported.add("minItems");
	}
	if (typeof schema.maxItems === "number") {
		value += `.max(${schema.maxItems})`;
		supported.add("maxItems");
	}
	if (schema.uniqueItems === true) {
		value +=
			'.refine((items) => new Set(items.map((item) => JSON.stringify(item))).size === items.length, "Expected unique items")';
		supported.add("uniqueItems");
	}
	return withSchemaMetadata(schema, value, supported);
}

function objectSchemaDsl(schema: Readonly<JsonSchema>): string {
	const properties = schema.properties as Record<string, JsonSchema> | undefined;
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [],
	);
	const additional = schema.additionalProperties;
	let value: string;
	if (properties !== undefined && Object.keys(properties).length > 0) {
		value = `z.object(${objectDsl(
			Object.entries(properties).map(([name, property]) => {
				const propertyValue = jsonSchemaDsl(property);
				return [name, required.has(name) ? propertyValue : `${propertyValue}.optional()`];
			}),
		)})`;
		if (additional === false) value += ".strict()";
		else if (typeof additional === "object" && additional !== null) {
			value += `.catchall(${jsonSchemaDsl(additional as JsonSchema)})`;
		} else value += ".loose()";
	} else if (typeof additional === "object" && additional !== null) {
		value = `z.record(z.string(), ${jsonSchemaDsl(additional as JsonSchema)})`;
	} else {
		value = additional === false ? "z.object({}).strict()" : "z.looseObject({})";
	}
	const supported = new Set(["type", "properties", "required", "additionalProperties"]);
	if (typeof schema.minProperties === "number") {
		value += `.refine((object) => Object.keys(object).length >= ${schema.minProperties}, "Expected at least ${schema.minProperties} properties")`;
		supported.add("minProperties");
	}
	if (typeof schema.maxProperties === "number") {
		value += `.refine((object) => Object.keys(object).length <= ${schema.maxProperties}, "Expected at most ${schema.maxProperties} properties")`;
		supported.add("maxProperties");
	}
	return withSchemaMetadata(schema, value, supported);
}

function withSchemaMetadata(schema: Readonly<JsonSchema>, value: string, supported: ReadonlySet<string>): string {
	const unsupported = Object.keys(schema).filter(
		(key) => !supported.has(key) && !SCHEMA_ANNOTATION_KEYS.has(key) && schema[key] !== undefined,
	);
	const warning = unsupported.length === 0 ? "" : ` /* unsupported JSON Schema keywords: ${unsupported.join(", ")} */`;
	const rendered = `${value}${warning}`;
	return "default" in schema && schema.default !== undefined
		? `${rendered}.default(${JSON.stringify(schema.default)})`
		: rendered;
}

function artifactsDsl(artifacts: Readonly<Record<string, ArtifactAst>> | undefined): string | undefined {
	if (artifacts === undefined || Object.keys(artifacts).length === 0) return undefined;
	return objectDsl(Object.entries(artifacts).map(([name, value]) => [name, artifactDsl(value)]));
}

function artifactDsl(value: ArtifactAst): string {
	const path = templateDsl(value.path) ?? stringDsl("");
	return value.shape === undefined ? path : `artifact(${path}, ${schemaDsl(value.shape)})`;
}

function readsDsl(reads: readonly (TemplateAst | ArtifactOfAst | JoinArtifactOfAst)[] | undefined): string | undefined {
	if (reads === undefined || reads.length === 0) return undefined;
	return arrayDsl(reads.map(readDsl));
}

function readDsl(read: TemplateAst | ArtifactOfAst | JoinArtifactOfAst): string {
	if (read.kind === "artifactOf") return artifactOfDsl(read);
	if (read.kind === "joinArtifactOf") return joinArtifactOfDsl(read);
	return templateDsl(read) ?? stringDsl("");
}

function artifactOfDsl(read: ArtifactOfAst): string {
	const options = objectDsl([
		["artifact", read.artifact === undefined ? undefined : stringDsl(read.artifact)],
		["select", read.select === undefined ? undefined : stringDsl(read.select)],
	]);
	return options === "{}" ? `artifactOf(${stringDsl(read.state)})` : `artifactOf(${stringDsl(read.state)}, ${options})`;
}

function joinArtifactOfDsl(read: JoinArtifactOfAst): string {
	const options = objectDsl([["artifact", read.artifact === undefined ? undefined : stringDsl(read.artifact)]]);
	return options === "{}"
		? `joinArtifactOf(${stringDsl(read.state)})`
		: `joinArtifactOf(${stringDsl(read.state)}, ${options})`;
}

function envDsl(
	env: Readonly<Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst>> | undefined,
): string | undefined {
	if (env === undefined || Object.keys(env).length === 0) return undefined;
	return objectDsl(Object.entries(env).map(([name, value]) => [name, readDsl(value)]));
}
