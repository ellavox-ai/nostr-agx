import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	// Only the clock the pause after a failed start is measured with: no waiting in tests.
	vi.useFakeTimers({ toFake: ["performance"] });
});

afterEach(() => {
	vi.useRealTimers();
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

	it("starts again on the next send after a failed start", async () => {
		mocks.createTransport.mockRejectedValueOnce(new Error("launcher could not start"));
		const ui = holder();
		await expect(ui.get()).rejects.toThrow(/launcher could not start/);

		vi.advanceTimersByTime(30_000);
		const transport = await ui.get().catch((error: unknown) => error);
		expect(mocks.createTransport, "the failed start was kept instead of tried again").toHaveBeenCalledTimes(2);
		expect(transport).toMatchObject({ stop: mocks.stop });
		expect(await ui.get()).toBe(transport);
		expect(mocks.createTransport).toHaveBeenCalledTimes(2);

		await ui.close();
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("does not start again until a pause is over, and gives the last failure meanwhile", async () => {
		const failure = new Error("launcher could not start");
		mocks.createTransport.mockRejectedValueOnce(failure);
		const ui = holder();
		await expect(ui.get()).rejects.toBe(failure);

		vi.advanceTimersByTime(29_999);
		await expect(ui.get()).rejects.toBe(failure);
		expect(mocks.createTransport, "started again inside the pause").toHaveBeenCalledOnce();

		vi.advanceTimersByTime(1);
		const transport = await ui.get();
		expect(mocks.createTransport).toHaveBeenCalledTimes(2);
		expect(transport).toMatchObject({ stop: mocks.stop });
		await ui.close();
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("doubles the pause after each failed start, up to five minutes", async () => {
		mocks.createTransport.mockRejectedValue(new Error("launcher could not start"));
		const ui = holder();
		await expect(ui.get()).rejects.toThrow(/could not start/);
		let starts = 1;
		for (const seconds of [30, 60, 120, 240, 300, 300, 300]) {
			vi.advanceTimersByTime(seconds * 1000 - 1);
			await expect(ui.get()).rejects.toThrow(/could not start/);
			expect(mocks.createTransport, `started again inside the ${seconds} s pause`).toHaveBeenCalledTimes(starts);
			vi.advanceTimersByTime(1);
			await expect(ui.get()).rejects.toThrow(/could not start/);
			starts += 1;
			expect(mocks.createTransport, `did not start again after the ${seconds} s pause`).toHaveBeenCalledTimes(starts);
		}
	});

	it("counts the pause down in whole seconds, rounded up, and is 0 when nothing is waiting", async () => {
		mocks.createTransport.mockRejectedValueOnce(new Error("launcher could not start"));
		const ui = holder();
		expect(ui.retryInSeconds(), "before any start").toBe(0);
		await expect(ui.get()).rejects.toThrow(/could not start/);
		expect(ui.retryInSeconds()).toBe(30);
		vi.advanceTimersByTime(12_500);
		expect(ui.retryInSeconds(), "17.5 s left rounds up").toBe(18);
		vi.advanceTimersByTime(17_499);
		expect(ui.retryInSeconds(), "a millisecond left rounds up").toBe(1);
		vi.advanceTimersByTime(1);
		expect(ui.retryInSeconds(), "pause over").toBe(0);
		vi.advanceTimersByTime(5_000);
		expect(ui.retryInSeconds(), "well after the pause").toBe(0);
		await ui.get();
		expect(ui.retryInSeconds(), "after a good start").toBe(0);
		await ui.close();
	});

	it("gives sends that wait on the same failed start the same failure", async () => {
		let fail!: (error: Error) => void;
		mocks.createTransport.mockImplementationOnce(
			() => new Promise((_resolve, reject) => { fail = reject; }),
		);
		const ui = holder();
		const first = ui.get();
		const second = ui.get();
		expect(mocks.createTransport).toHaveBeenCalledOnce();
		fail(new Error("launcher could not start"));
		await expect(first).rejects.toThrow(/could not start/);
		await expect(second).rejects.toThrow(/could not start/);
		expect(mocks.createTransport).toHaveBeenCalledOnce();
	});

	it("closes cleanly after a failed start", async () => {
		mocks.createTransport.mockRejectedValueOnce(new Error("launcher could not start"));
		const ui = holder();
		await expect(ui.get()).rejects.toThrow();
		await expect(ui.close()).resolves.toBeUndefined();
		expect(mocks.stop).not.toHaveBeenCalled();
	});

	it("starts nothing when no send happened", async () => {
		const ui = holder();
		await ui.close();
		expect(mocks.createTransport).not.toHaveBeenCalled();
		expect(mocks.stop).not.toHaveBeenCalled();
	});
});
