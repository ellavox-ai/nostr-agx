import { describe, expect, it } from "vitest";
import { runtime } from "../lib/runtime.js";

describe("test setup", () => {
	it("refuses every host but this machine, the way an offline machine does", async () => {
		const error = await runtime()
			.fetch("https://app.ellaworks.ai/api/rpc/account/principal/get", { method: "POST" })
			.then(
				() => null,
				(e: unknown) => e as TypeError & { cause?: { code?: string } },
			);
		expect(error).toBeInstanceOf(TypeError);
		expect(error?.message).toBe("fetch failed");
		expect(error?.cause?.code).toBe("ECONNREFUSED");
	});
});
