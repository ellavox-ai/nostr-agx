import { afterEach, describe, expect, it } from "vitest";
import { AgxCliError, EXIT } from "../errors.js";
import { loadTailscaleSdk, setTailscaleSdkLoaderForTests } from "./sdk.js";

describe("loadTailscaleSdk", () => {
	afterEach(() => {
		setTailscaleSdkLoaderForTests();
	});

	it("reports an actionable error when the optional package is absent", async () => {
		setTailscaleSdkLoaderForTests(async () => {
			throw new Error("Cannot find package '@nostr-agx/tailscale'");
		});

		const error = await loadTailscaleSdk().catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).exitCode).toBe(EXIT.config);
		expect((error as AgxCliError).message).toMatch(/not installed/);
		expect((error as AgxCliError).remediation).toMatch(
			/npm install -g @nostr-agx\/cli @nostr-agx\/tailscale/,
		);
	});
});
