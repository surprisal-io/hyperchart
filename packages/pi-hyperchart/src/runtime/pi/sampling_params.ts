import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Sets sampling parameters (temperature, top_p, ...) on every provider request of one invocation.
 * Pi models carry sampling parameters per model only; a chart needs them per action, so that one
 * agent can answer deterministically while another on the same model keeps the provider default.
 * The keys are written at the top level of the request body, where OpenAI-compatible providers
 * read them, and replace values the model or Pi put there.
 */
export function samplingParamsExtension(params: Readonly<Record<string, unknown>>): InlineExtension {
	return {
		name: "hyperchart-sampling-params",
		hidden: true,
		factory: (pi) => {
			pi.on("before_provider_request", (event) => withSamplingParams(event.payload, params));
		},
	};
}

/** Returns the payload with the parameters set, or undefined when it is not a request object. */
export function withSamplingParams(payload: unknown, params: Readonly<Record<string, unknown>>): unknown {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		return undefined;
	}
	return { ...payload, ...params };
}
