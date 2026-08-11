type Assertion = {
	(condition: unknown, message?: string): asserts condition;
	equal(actual: unknown, expected: unknown, message?: string): void;
	notEqual(actual: unknown, expected: unknown, message?: string): void;
	deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
};

function fail(message = "Assertion failed"): never {
	throw new Error(message);
}

function deepEqual(actual: unknown, expected: unknown): boolean {
	if (Object.is(actual, expected)) return true;
	if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null) return false;
	if (Array.isArray(actual) !== Array.isArray(expected)) return false;
	const actualKeys = Object.keys(actual);
	const expectedKeys = Object.keys(expected);
	if (actualKeys.length !== expectedKeys.length || actualKeys.some((key) => !Object.hasOwn(expected, key))) return false;
	return actualKeys.every((key) => deepEqual((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]));
}

const assert: Assertion = (condition: unknown, message?: string): asserts condition => {
	if (!condition) fail(message);
};

assert.equal = (actual, expected, message) => {
	if (!Object.is(actual, expected)) fail(message);
};
assert.notEqual = (actual, expected, message) => {
	if (Object.is(actual, expected)) fail(message);
};
assert.deepStrictEqual = (actual, expected, message) => {
	if (!deepEqual(actual, expected)) fail(message);
};

export default assert;
