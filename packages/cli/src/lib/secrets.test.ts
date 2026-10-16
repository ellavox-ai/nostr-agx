import { describe, expect, it, vi } from "vitest";
import { reportCliError } from "../program.js";
import { EXIT } from "./errors.js";
import {
	isWellFormedApiKey,
	malformedApiKeyError,
	redactSecrets,
	rememberSecret,
} from "./secrets.js";

describe("isWellFormedApiKey", () => {
	it("accepts printable ASCII without spaces, up to 512 characters", () => {
		expect(isWellFormedApiKey(`ela_${"A".repeat(64)}`)).toBe(true);
		expect(isWellFormedApiKey("x".repeat(512))).toBe(true);
	});

	it.each([
		["empty", ""],
		["LF", "ela_a\nb"],
		["CR", "ela_a\rb"],
		["NUL", "ela_a\u0000b"],
		["a space", "ela_a b"],
		["a tab", "ela_a\tb"],
		["DEL", "ela_a\u007fb"],
		["non-ASCII", "ela_ä"],
		["too long", "x".repeat(513)],
		["not a string", 42],
	])("refuses %s", (_label, value) => {
		expect(isWellFormedApiKey(value)).toBe(false);
	});

	it("the error never quotes the value", () => {
		const error = malformedApiKeyError("AGX_API_KEY");
		expect(error.exitCode).toBe(EXIT.config);
		expect(error.message).toMatch(/AGX_API_KEY is not a valid API key/);
	});
});

describe("redactSecrets", () => {
	it("removes a remembered key as is, JSON-escaped, and each run between control characters", () => {
		const key = "ela_REDACTMEREDACTME\nTAILTAILTAIL";
		rememberSecret(key);
		expect(redactSecrets(`a ${key} b`)).toBe("a [redacted] b");
		expect(redactSecrets(`a ${JSON.stringify(key)} b`)).toBe('a "[redacted]" b');
		expect(redactSecrets("only ela_REDACTMEREDACTME here")).toBe("only [redacted] here");
		expect(redactSecrets("and TAILTAILTAIL")).toBe("and [redacted]");
	});

	it("leaves text alone when it holds no secret, and ignores short values", () => {
		rememberSecret("short");
		expect(redactSecrets("a short message")).toBe("a short message");
	});
});

describe("reportCliError", () => {
	it("redacts remembered keys from a raw error and its AGX_DEBUG stack", () => {
		rememberSecret("ela_STACKSECRETSTACKSECRET");
		const lines: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		process.env.AGX_DEBUG = "1";
		try {
			const code = reportCliError(new TypeError('Headers.append: "ela_STACKSECRETSTACKSECRET" is an invalid header value.'));
			expect(code).toBe(EXIT.generic);
		} finally {
			delete process.env.AGX_DEBUG;
			spy.mockRestore();
		}
		expect(lines.join("\n")).not.toContain("STACKSECRET");
		expect(lines.join("\n")).toContain("[redacted]");
	});
});
