import { promises as fsp } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RenderedArtifact } from "../../core/machine.js";
import { errorMessage } from "../../utils/errors.js";
import { checkSchema, type SchemaCheck } from "./schema.js";

export async function resolveArtifactValue(artifact: RenderedArtifact, workDir: string): Promise<unknown> {
	const filePath = artifactPath(artifact, workDir);
	let content: string;
	try {
		content = await fsp.readFile(filePath, "utf8");
	} catch (error) {
		throw new Error(`Artifact ${artifact.path}: cannot read ${filePath}: ${errorMessage(error)}`);
	}

	if (artifact.shape === undefined && artifact.select === undefined) {
		return content;
	}

	const parsed = parseJsonArtifact(content, artifact.path);
	if (artifact.shape !== undefined) {
		const check = checkSchema(artifact.shape, parsed);
		if (!check.ok) {
			throw new Error(`Artifact ${artifact.path}: schema mismatch: ${check.errors.join("; ")}`);
		}
	}

	return selectArtifactPath(parsed, artifact.select, artifact.path);
}

export function serializeEnvValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

export async function checkArtifactFile(artifact: RenderedArtifact, workDir: string): Promise<SchemaCheck> {
	let filePath: string;
	try {
		filePath = artifactPath(artifact, workDir);
	} catch (error) {
		return { ok: false, errors: [errorMessage(error)] };
	}
	let content: string;
	try {
		content = await fsp.readFile(filePath, "utf8");
	} catch (error) {
		return { ok: false, errors: [`${artifact.path}: cannot read ${filePath}: ${errorMessage(error)}`] };
	}

	if (artifact.shape === undefined) {
		return { ok: true };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		return { ok: false, errors: [`${artifact.path}: invalid JSON: ${errorMessage(error)}`] };
	}

	const check = checkSchema(artifact.shape, parsed);
	return check.ok ? check : { ok: false, errors: check.errors.map((message) => `${artifact.path}: ${message}`) };
}

function artifactPath(artifact: RenderedArtifact, workDir: string): string {
	const root = resolve(workDir);
	const filePath = resolve(root, artifact.path);
	const relativePath = relative(root, filePath);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`Artifact ${artifact.path}: path escapes workDir ${root}`);
	}
	return filePath;
}

function parseJsonArtifact(content: string, artifactPath: string): unknown {
	try {
		return JSON.parse(content);
	} catch (error) {
		throw new Error(`Artifact ${artifactPath}: invalid JSON: ${errorMessage(error)}`);
	}
}

function selectArtifactPath(value: unknown, select: string | undefined, artifactPath: string): unknown {
	if (select === undefined) {
		return value;
	}
	let current = value;
	for (const segment of select.split(".")) {
		if (typeof current !== "object" || current === null || !(segment in current)) {
			throw new Error(`Artifact ${artifactPath}: selector '${select}' cannot resolve segment '${segment}'`);
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}
