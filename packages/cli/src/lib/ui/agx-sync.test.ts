import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrTransport } from "@nostr-agx/nostr";
import { getProfile } from "../config.js";
import type { Identity } from "../identity.js";
import { sandbox } from "../../test/helpers.js";
import type { MessageStore } from "../store/message-store.js";
import { createAgxSync } from "./agx-sync.js";

const mocks = vi.hoisted(() => ({
	createTransport: vi.fn(),
	madeStop: vi.fn(async () => undefined),
}));

vi.mock("../transport.js", () => ({
	createTransport: mocks.createTransport,
	makeLogger: () => undefined,
}));

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
	vi.clearAllMocks();
	mocks.createTransport.mockResolvedValue({ stop: mocks.madeStop });
});
afterEach(() => {
	box.restore();
});

function options(transport?: NostrTransport) {
	return {
		profileName: "default",
		// A throwaway relay that refuses: nothing here may reach the default relay address.
		profile: { ...getProfile("default"), relays: ["ws://127.0.0.1:9"] },
		identity: {} as Identity,
		store: { flush: vi.fn(), absorbSpool: vi.fn() } as unknown as MessageStore,
		allowed: new Set<string>(),
		verbose: false,
		...(transport ? { transport } : {}),
	};
}

describe("createAgxSync transport", () => {
	it("makes and stops its own transport when none is given", async () => {
		const sync = await createAgxSync(options());
		expect(mocks.createTransport).toHaveBeenCalledOnce();
		await sync.close();
		expect(mocks.madeStop).toHaveBeenCalledOnce();
	});

	it("uses a transport it is given and leaves it running on close", async () => {
		const stop = vi.fn(async () => undefined);
		const given = { stop } as unknown as NostrTransport;
		const sync = await createAgxSync(options(given));
		expect(mocks.createTransport).not.toHaveBeenCalled();
		await sync.close();
		expect(stop).not.toHaveBeenCalled();
		expect(mocks.madeStop).not.toHaveBeenCalled();
	});
});
