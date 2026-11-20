import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agx, capture, sandbox } from "../test/helpers.js";
import { sendCommand } from "./send.js";

const mocks = vi.hoisted(() => ({
	createTransport: vi.fn(),
	publishMessage: vi.fn(),
	stop: vi.fn(async () => undefined),
}));

vi.mock("../lib/transport.js", () => ({
	createTransport: mocks.createTransport,
	makeLogger: () => undefined,
}));

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
	vi.clearAllMocks();
	mocks.createTransport.mockImplementation(async () => ({
		publishMessage: mocks.publishMessage,
		stop: mocks.stop,
	}));
	mocks.publishMessage.mockResolvedValue({
		ok: true,
		eventId: "evt1",
		contextId: "ctx1",
		accepted: 1,
		total: 1,
		rejected: [],
		errors: [],
	});
});

afterEach(() => box.restore());

async function newIdentity(): Promise<string> {
	expect((await agx("identity", "new")).code).toBe(0);
	const shown = await agx("identity", "show");
	const npub = /npub1[0-9a-z]+/.exec(shown.stdout)?.[0];
	if (!npub) {
		throw new Error("no npub in `identity show` output");
	}
	return npub;
}

describe("sendCommand transport lifecycle", () => {
	it("stops the transport after a successful send", async () => {
		const self = await newIdentity();
		const { value } = await capture(() => sendCommand(self, "hi", {}));
		expect(value).toBeUndefined();
		expect(mocks.publishMessage).toHaveBeenCalledOnce();
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("stops the transport when publishing fails", async () => {
		const self = await newIdentity();
		mocks.publishMessage.mockResolvedValue({
			ok: false,
			eventId: "",
			contextId: "",
			accepted: 0,
			total: 0,
			rejected: [],
			errors: ["message too long"],
		});
		await expect(
			capture(() => sendCommand(self, "hi", {})).then((run) => run.value),
		).rejects.toThrow(/message too long/);
		expect(mocks.stop).toHaveBeenCalledOnce();
	});
});
