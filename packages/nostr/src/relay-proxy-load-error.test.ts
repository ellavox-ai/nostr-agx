import { describe, expect, it, vi } from "vitest";

// The package is present, but loading it fails. A bundler that copies it into one
// file does this: its own CommonJS dependencies then call `require` where none exists.
// Vitest wraps whatever a mock factory throws, so the error the loader sees has the
// one thrown here somewhere along its `cause` chain.
const LOAD_FAILURE = new Error('Dynamic require of "events" is not supported');

vi.mock("socks-proxy-agent", () => {
	throw LOAD_FAILURE;
});

class FakeWebSocket {}

type Failure = Error & { remediation?: string; cause?: Error };

async function failure(): Promise<Failure> {
	const { createProxyWebSocket } = await import("./relay-proxy");
	return (await createProxyWebSocket(
		"socks5://127.0.0.1:1080",
		FakeWebSocket,
	).catch((e: unknown) => e)) as Failure;
}

describe("createProxyWebSocket when socks-proxy-agent fails to load", () => {
	it("is a RelayProxyError", async () => {
		const { RelayProxyError } = await import("./relay-proxy");
		expect(await failure()).toBeInstanceOf(RelayProxyError);
	});

	it("keeps the original error as the cause", async () => {
		let cause: Error | undefined = (await failure()).cause;
		while (cause && cause !== LOAD_FAILURE) {
			cause = cause.cause as Error | undefined;
		}
		expect(cause).toBe(LOAD_FAILURE);
	});

	it("says in the message why it failed", async () => {
		const error = await failure();
		expect(error.cause?.message).toBeTruthy();
		expect(error.message).toContain(error.cause?.message);
	});

	it("does not claim the package is missing", async () => {
		expect((await failure()).message).not.toMatch(/requires the optional/);
	});

	it("still points to the package by name", async () => {
		const error = await failure();
		expect(`${error.message} ${error.remediation}`).toContain(
			"socks-proxy-agent",
		);
	});
});
