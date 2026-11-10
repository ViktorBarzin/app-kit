/**
 * The checks both entry points share: product event names, property keys,
 * the properties' size, and which hostnames count as production. The event
 * pipeline applies the same rules and rejects events that break them, so
 * the clients drop or trim them first instead of sending events that would
 * be refused.
 */

/** `noun.past_verb` in lower case, e.g. `recording.started`. */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
/** snake_case property keys. */
export const PROPERTY_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
/** The longest `properties` object, as JSON, the pipeline accepts. */
export const MAX_PROPERTIES_LENGTH = 2048;

export type EventProperties = Record<string, unknown>;

/**
 * The header a browser sets on same-origin API calls to its Rybbit visitor
 * id, so the server's events join the browser's person in Rybbit.
 */
export const VISITOR_HEADER = "X-Visitor-Id";
/** Where the Rybbit script (namespace `rybbit`) keeps its visitor id. */
export const VISITOR_STORAGE_KEY = "rybbit-visitor-id";

export interface EventCheck {
	/** The event to send, with invalid keys removed; null when it cannot be sent. */
	accepted: { event: string; properties: EventProperties } | null;
	/** What was wrong, one line each. Empty when the event passed as given. */
	problems: string[];
}

/**
 * Check a product event against the telemetry standard. A bad name or
 * properties over the size limit refuse the event; keys that are not
 * snake_case are dropped from it and reported.
 */
export function checkEvent(
	name: string,
	properties: EventProperties = {},
): EventCheck {
	if (!EVENT_NAME_PATTERN.test(name))
		return {
			accepted: null,
			problems: [`event name is not noun.past_verb: ${JSON.stringify(name)}`],
		};
	const problems: string[] = [];
	const kept: EventProperties = {};
	for (const [key, value] of Object.entries(properties)) {
		if (PROPERTY_KEY_PATTERN.test(key)) kept[key] = value;
		else
			problems.push(`property key is not snake_case: ${JSON.stringify(key)}`);
	}
	const length = JSON.stringify(kept).length;
	if (length > MAX_PROPERTIES_LENGTH)
		return {
			accepted: null,
			problems: [
				...problems,
				`properties are ${length} characters as JSON, over ${MAX_PROPERTIES_LENGTH}`,
			],
		};
	return { accepted: { event: name, properties: kept }, problems };
}

/**
 * Whether `hostname` is one of `productionHosts` or a subdomain of one.
 * `["example.com"]` matches `example.com` and `app.example.com`, not
 * `badexample.com` or `localhost`.
 */
export function isProductionHost(
	hostname: string,
	productionHosts: readonly string[],
): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host === "") return false;
	return productionHosts.some((entry) => {
		const domain = entry.toLowerCase().replace(/\.$/, "");
		return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
	});
}
