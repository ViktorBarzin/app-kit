/**
 * Second bun test preload (bunfig.toml): jest-dom matchers, unmount after
 * each test, and quieter logs (set LOG_LEVEL to see them).
 */
import { afterEach, expect } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { setLogLevel } from "@viktorbarzin/log";

expect.extend(matchers);

afterEach(() => {
	cleanup();
});

if (!process.env.LOG_LEVEL) setLogLevel("WARNING");
