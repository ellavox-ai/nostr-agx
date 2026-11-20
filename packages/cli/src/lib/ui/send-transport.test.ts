import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../config.js";
import type { Identity } from "../identity.js";
import { createUiSendTransport } from "./send-transport.js";

const mocks = vi.hoisted(() => ({
	createTransport: vi.fn(),
	stop: vi.fn(async () => undefined),
}));

vi.mock("../transport.js", () => ({
	createTransport: mocks.createTransport,
	makeLogger: () => undefined,
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createTransport.mockResolvedValue({ stop: mocks.stop });
});

function holder() {
	return createUiSendTransport({} as unknown as Profile, {} as unknown as Identity, {
		profileName: "default",
		verbose: false,
	});
}

describe("createUiSendTransport", () => {
	it("creates one transport for every send and stops it once at shutdown", async () => {
		const ui = holder();
		const first = await ui.get();
		const second = await ui.get();
		expect(second).toBe(first);
		expect(mocks.createTransport).toHaveBeenCalledOnce();

		await ui.close();
		expect(mocks.stop).toHaveBeenCalledOnce();
		await ui.close();
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("shares one in-flight creation between concurrent sends", async () => {
		let finish!: (transport: unknown) => void;
		mocks.createTransport.mockImplementation(
			() => new Promise((resolve) => { finish = resolve; }),
		);
		const ui = holder();
		const first = ui.get();
		const second = ui.get();
		expect(mocks.createTransport).toHaveBeenCalledOnce();

		const transport = { stop: mocks.stop };
		finish(transport);
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(transport);
		expect(b).toBe(transport);

		await ui.close();
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("stops a transport whose creation was still in flight at shutdown", async () => {
		let finish!: (transport: unknown) => void;
		mocks.createTransport.mockImplementation(
			() => new Promise((resolve) => { finish = resolve; }),
		);
		const ui = holder();
		const creating = ui.get();
		const closing = ui.close();
		finish({ stop: mocks.stop });
		await Promise.all([creating, closing]);
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("starts nothing when no send happened", async () => {
		const ui = holder();
		await ui.close();
		expect(mocks.createTransport).not.toHaveBeenCalled();
		expect(mocks.stop).not.toHaveBeenCalled();
	});
});
