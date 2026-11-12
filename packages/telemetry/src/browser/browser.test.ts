import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
	type BrowserRuntime,
	createBrowserTelemetry,
	type RybbitLike,
	rybbitScriptAttributes,
	type SegmentLike,
	type SegmentLoadArgs,
	type SentryBrowserLike,
	segmentLoadArgs,
} from "./core.js";

interface Fake {
	runtime: BrowserRuntime;
	scripts: Record<string, string>[];
	loads: SegmentLoadArgs[];
	segment: string[][];
	rybbit: string[][];
	sentry: string[][];
	warnings: string[];
	/** What localStorage `rybbit-visitor-id` holds; the script sets it on load. */
	storedVisitorId: string | undefined;
	loadScript(visitorId?: string): void;
	/** The script tag fired its error event (blocked, offline). */
	failScript(): void;
	/** Run every callback given to `runtime.after`, as if its time passed. */
	elapse(): void;
	/** The delays asked of `runtime.after`. */
	delays: number[];
}

function fake(hostname: string, port = ""): Fake {
	const scripts: Record<string, string>[] = [];
	const loads: SegmentLoadArgs[] = [];
	const segment: string[][] = [];
	const rybbit: string[][] = [];
	const warnings: string[] = [];
	const onLoads: (() => void)[] = [];
	const onErrors: (() => void)[] = [];
	const timers: (() => void)[] = [];
	let rybbitApi: RybbitLike | undefined;
	const segmentApi: SegmentLike = {
		track: (name, properties) =>
			void segment.push(["track", name, JSON.stringify(properties)]),
		identify: (id, traits) =>
			void segment.push(["identify", id, JSON.stringify(traits)]),
		reset: () => void segment.push(["reset"]),
		setAnonymousId: (id) => void segment.push(["setAnonymousId", id]),
	};
	const f: Fake = {
		scripts,
		loads,
		segment,
		rybbit,
		sentry: [],
		warnings,
		storedVisitorId: undefined,
		delays: [],
		runtime: {
			hostname,
			host: port ? `${hostname}:${port}` : hostname,
			injectScript: (attributes, onLoad, onError) => {
				scripts.push(attributes);
				onLoads.push(onLoad);
				onErrors.push(onError);
			},
			after: (ms, fn) => {
				f.delays.push(ms);
				timers.push(fn);
			},
			rybbit: () => rybbitApi,
			loadSegment: async (args) => {
				loads.push(args);
				return segmentApi;
			},
			warn: (message) => void warnings.push(message),
			visitorId: () => f.storedVisitorId,
		},
		loadScript(visitorId = "rv-1") {
			f.storedVisitorId ??= visitorId;
			rybbitApi = {
				identify: (id, traits) =>
					void rybbit.push(["identify", id, JSON.stringify(traits)]),
				clearUserId: () => void rybbit.push(["clearUserId"]),
			};
			for (const fn of onLoads.splice(0)) fn();
		},
		failScript() {
			for (const fn of onErrors.splice(0)) fn();
		},
		elapse() {
			for (const fn of timers.splice(0)) fn();
		},
	};
	return f;
}

const base = {
	writeKey: "wk-test",
	siteId: 1,
	release: "abc123",
	productionHosts: ["example.com"],
};

function fakeSentry(f: Fake) {
	return {
		init: (options: { dsn: string; release: string; environment: string }) =>
			void f.sentry.push([
				"init",
				options.dsn,
				options.release,
				options.environment,
			]),
		setUser: (user: { id: string } | null) =>
			void f.sentry.push(["setUser", user?.id ?? "null"]),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("rybbitScriptAttributes", () => {
	test("the script tag: site id, deferred, only password inputs masked", () => {
		expect(rybbitScriptAttributes("1", "/_t")).toEqual({
			src: "/_t/r/script.js",
			"data-site-id": "1",
			defer: "",
			"data-replay-mask-all-inputs": "false",
			"data-replay-mask-input-options": '{"password":true}',
		});
	});
});

describe("segmentLoadArgs", () => {
	test("inline settings point at the ingest path and turn metrics off", () => {
		const [settings, options] = segmentLoadArgs("wk", "app.example.com", "/_t");
		expect(settings).toEqual({
			writeKey: "wk",
			cdnURL: "https://app.example.com/_t/e",
			cdnSettings: {
				integrations: {
					"Segment.io": {
						apiKey: "wk",
						apiHost: "app.example.com/_t/e/v1",
						protocol: "https",
					},
				},
				metrics: { sampleRate: 0 },
			},
		});
		expect(options).toEqual({
			initialPageview: false,
			integrations: {
				"Segment.io": {
					apiHost: "app.example.com/_t/e/v1",
					protocol: "https",
				},
			},
		});
	});

	test("the host keeps its port", () => {
		const [settings] = segmentLoadArgs("wk", "app.example.com:8443", "/_t");
		expect(settings.cdnSettings?.integrations["Segment.io"].apiHost).toBe(
			"app.example.com:8443/_t/e/v1",
		);
	});
});

describe("createBrowserTelemetry", () => {
	test("off a production host it loads nothing and sends nothing", async () => {
		const f = fake("localhost", "3000");
		const t = createBrowserTelemetry(
			{ ...base, dsn: "https://k@example.com/_t/x/1", sentry: fakeSentry(f) },
			f.runtime,
		);
		t.track("item.created", { item_id: 1 });
		t.identify("sub-1");
		t.reset();
		await settle();
		expect(t.active).toBe(false);
		expect(f.scripts).toEqual([]);
		expect(f.loads).toEqual([]);
		expect(f.segment).toEqual([]);
		expect(f.sentry).toEqual([]);
	});

	test("off a production host, an invalid event is reported as a warning", () => {
		const f = fake("localhost");
		const t = createBrowserTelemetry(base, f.runtime);
		t.track("ItemCreated", { itemId: 1 });
		expect(f.warnings).toEqual([
			'telemetry: event name is not noun.past_verb: "ItemCreated"',
		]);
	});

	test("on a production host it injects the script, loads Segment and initialises Sentry", async () => {
		const f = fake("app.example.com");
		const t = createBrowserTelemetry(
			{
				...base,
				dsn: "https://k@app.example.com/_t/x/1",
				sentry: fakeSentry(f),
			},
			f.runtime,
		);
		await settle();
		expect(t.active).toBe(true);
		expect(f.scripts).toEqual([rybbitScriptAttributes("1", "/_t")]);
		expect(f.loads).toEqual([
			segmentLoadArgs("wk-test", "app.example.com", "/_t"),
		]);
		expect(f.sentry).toEqual([
			["init", "https://k@app.example.com/_t/x/1", "abc123", "production"],
		]);
	});

	test("track sends valid events, trims bad keys and drops bad names, silently", async () => {
		const f = fake("example.com");
		f.storedVisitorId = "rv-1";
		const t = createBrowserTelemetry(base, f.runtime);
		t.track("item.created", { item_id: 1, itemName: "x" });
		t.track("Item Created");
		await settle();
		expect(f.segment).toEqual([
			["setAnonymousId", "rv-1"],
			["track", "item.created", '{"item_id":1}'],
		]);
		expect(f.warnings).toEqual([]);
	});

	test("identify reaches Segment, Rybbit (once its script has loaded) and Sentry", async () => {
		const f = fake("app.example.com");
		const t = createBrowserTelemetry(
			{ ...base, sentry: fakeSentry(f), dsn: "d" },
			f.runtime,
		);
		t.identify("sub-1", { plan: "free" });
		await settle();
		expect(f.rybbit).toEqual([]);
		f.loadScript();
		await settle();
		expect(f.segment).toEqual([
			["setAnonymousId", "rv-1"],
			["identify", "sub-1", '{"plan":"free"}'],
		]);
		expect(f.rybbit).toEqual([["identify", "sub-1", '{"plan":"free"}']]);
		expect(f.sentry.at(-1)).toEqual(["setUser", "sub-1"]);
	});

	test("reset clears the person in all three", async () => {
		const f = fake("app.example.com");
		const t = createBrowserTelemetry(
			{ ...base, sentry: fakeSentry(f), dsn: "d" },
			f.runtime,
		);
		f.loadScript();
		t.identify("sub-1");
		t.reset();
		await settle();
		expect(f.segment.map((call) => call[0])).toEqual([
			"setAnonymousId",
			"identify",
			"reset",
		]);
		expect(f.rybbit.map((call) => call[0])).toEqual([
			"identify",
			"clearUserId",
		]);
		expect(f.sentry.at(-1)).toEqual(["setUser", "null"]);
	});

	test("Sentry is left alone without a DSN", async () => {
		const f = fake("app.example.com");
		createBrowserTelemetry({ ...base, sentry: fakeSentry(f) }, f.runtime);
		await settle();
		expect(f.sentry).toEqual([]);
	});

	test("a custom ingest path moves the script and the events", async () => {
		const f = fake("app.example.com");
		createBrowserTelemetry({ ...base, ingestPath: "/telemetry/" }, f.runtime);
		await settle();
		expect(f.scripts[0]?.src).toBe("/telemetry/r/script.js");
		expect(
			f.loads[0]?.[0].cdnSettings?.integrations["Segment.io"].apiHost,
		).toBe("app.example.com/telemetry/e/v1");
	});

	test("once the Rybbit script has run, Segment's anonymousId is its visitor id", async () => {
		const f = fake("app.example.com");
		const t = createBrowserTelemetry(base, f.runtime);
		await settle();
		expect(t.visitorHeaders()).toEqual({});
		f.loadScript("rv-9");
		await settle();
		expect(f.segment).toEqual([["setAnonymousId", "rv-9"]]);
		expect(t.visitorHeaders()).toEqual({ "X-Visitor-Id": "rv-9" });
	});

	test("a returning visitor's stored id is used before the script loads", async () => {
		const f = fake("app.example.com");
		f.storedVisitorId = "rv-old";
		const t = createBrowserTelemetry(base, f.runtime);
		t.track("item.created");
		await settle();
		expect(f.segment[0]).toEqual(["setAnonymousId", "rv-old"]);
		expect(f.segment[1]?.[0]).toBe("track");
		expect(t.visitorHeaders()).toEqual({ "X-Visitor-Id": "rv-old" });
	});

	test("a new visitor's Segment calls wait for the Rybbit visitor id", async () => {
		const f = fake("app.example.com");
		const t = createBrowserTelemetry({ ...base, personId: "p-1" }, f.runtime);
		t.track("item.created");
		await settle();
		expect(f.segment).toEqual([]);
		f.loadScript("rv-new");
		await settle();
		expect(f.segment.map((call) => call.slice(0, 2))).toEqual([
			["setAnonymousId", "rv-new"],
			["identify", "p-1"],
			["track", "item.created"],
		]);
	});

	test("if the Rybbit script fails to load, Segment calls still go out", async () => {
		const f = fake("app.example.com");
		const t = createBrowserTelemetry(base, f.runtime);
		t.track("item.created");
		f.failScript();
		await settle();
		expect(f.segment.map((call) => call[0])).toEqual(["track"]);
	});

	test("if the Rybbit script never answers, Segment calls go out after a wait", async () => {
		const f = fake("app.example.com");
		const t = createBrowserTelemetry(base, f.runtime);
		t.track("item.created");
		await settle();
		expect(f.segment).toEqual([]);
		expect(f.delays).toEqual([5000]);
		f.elapse();
		await settle();
		expect(f.segment.map((call) => call[0])).toEqual(["track"]);
	});

	test("off production there are no visitor headers", () => {
		const f = fake("localhost");
		f.storedVisitorId = "rv-1";
		expect(createBrowserTelemetry(base, f.runtime).visitorHeaders()).toEqual(
			{},
		);
	});

	test("a personId identifies the person on every init (property)", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.stringMatching(/^[a-f0-9]{8,64}$/),
				async (personId) => {
					const f = fake("app.example.com");
					createBrowserTelemetry(
						{ ...base, personId, sentry: fakeSentry(f), dsn: "d" },
						f.runtime,
					);
					f.loadScript();
					await settle();
					expect(f.rybbit).toEqual([
						["identify", personId, JSON.stringify(undefined)],
					]);
					expect(f.segment).toContainEqual([
						"identify",
						personId,
						JSON.stringify(undefined),
					]);
					expect(f.sentry.at(-1)).toEqual(["setUser", personId]);
				},
			),
			{ numRuns: 20 },
		);
	});

	test("without a personId nobody is identified", async () => {
		const f = fake("app.example.com");
		createBrowserTelemetry(base, f.runtime);
		f.loadScript();
		await settle();
		expect(f.rybbit).toEqual([]);
		expect(f.segment.map((call) => call[0])).toEqual(["setAnonymousId"]);
	});

	test("events are only ever sent from production hosts (property)", async () => {
		const host = fc.oneof(
			fc.constantFrom(
				"localhost",
				"127.0.0.1",
				"example.org",
				"badexample.com",
			),
			fc.stringMatching(/^[a-z]{1,8}$/).map((l) => `${l}.example.com`),
		);
		await fc.assert(
			fc.asyncProperty(host, async (hostname) => {
				const f = fake(hostname);
				f.storedVisitorId = "rv-1";
				const t = createBrowserTelemetry(base, f.runtime);
				t.track("item.created");
				await settle();
				const production = hostname.endsWith(".example.com");
				expect(f.segment.length > 0).toBe(production);
				expect(f.scripts.length > 0).toBe(production);
			}),
		);
	});
});

test("the @sentry/browser module fits SentryBrowserLike (typecheck)", () => {
	const fits = (module: typeof import("@sentry/browser")): SentryBrowserLike =>
		module;
	expect(typeof fits).toBe("function");
});
