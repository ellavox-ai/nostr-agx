import { describe, expect, it } from "vitest";
import { buildProgram } from "./program.js";

describe("relay command options", () => {
	it("does not advertise Tailscale options that cannot publish a local relay", () => {
		const relay = buildProgram().commands.find((cmd) => cmd.name() === "relay");
		expect(relay).toBeDefined();
		const longOptions = (relay?.options ?? []).map((option) => option.long);
		expect(longOptions).not.toContain("--tailscale");
		expect(longOptions).not.toContain("--without-tailscale");
	});
});
