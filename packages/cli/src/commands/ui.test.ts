import { createServer, type Socket } from "node:net";
import { generateKeypair } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveProfile, updateProfile } from "../lib/config.js";
import { toDisplayNpub } from "../lib/peer.js";
import { setStdinForTests } from "../lib/stdin.js";
import { setTailscaleStarterForTests } from "../lib/tailscale/index.js";
import { agx, sandbox } from "../test/helpers.js";
import { uiCommand } from "./ui.js";

// `agx ui` serves its page from three files that only exist after a build. These
// tests only need the server to run, so those three paths read as placeholder text.
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const isAsset = (path: unknown): boolean =>
		typeof path === "string" && /[\\/]commands[\\/]ui[\\/](index\.html|app\.js|app\.css)$/.test(path);
	return {
		...real,
		existsSync: (path: Parameters<typeof real.existsSync>[0]) => isAsset(path) || real.existsSync(path),
		readFileSync: ((path: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) =>
			isAsset(path)
				? '<meta name="csrf" content="__CSRF__">'
				: (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof real.readFileSync,
	};
});

/** Throwaway values, made fresh for every run. */
const RUN = Math.random().toString(16).slice(2, 10);
const KEY = `tskey-auth-ui-test-${RUN}-${Math.random().toString(16).slice(2, 18)}`;
const PROXY_USER = `user${RUN}`;
const PROXY_PASS = `pass${Math.random().toString(16).slice(2, 10)}`;
const RESERVED_PORTS = new Set([7447, 53505]);

interface Listener {
	port: number;
	/** Connections accepted so far; each one is dropped at once. */
	connections: number;
	close(): Promise<void>;
}

/** A local TCP listener on a free port that drops every connection and counts them. */
async function droppingListener(): Promise<Listener> {
	for (;;) {
		const sockets = new Set<Socket>();
		const listener: Listener = {
			port: 0,
			connections: 0,
			close: async () => {
				for (const socket of sockets) {
					socket.destroy();
				}
				await new Promise<void>((resolve) => server.close(() => resolve()));
			},
		};
		const server = createServer((socket) => {
			listener.connections += 1;
			sockets.add(socket);
			socket.on("error", () => undefined);
			socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		listener.port = (server.address() as { port: number }).port;
		if (!RESERVED_PORTS.has(listener.port)) {
			return listener;
		}
		await listener.close();
	}
}

async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${what}.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

let box: ReturnType<typeof sandbox>;
let relay: Listener;
let socks: Listener;
let starts = 0;
let started = 0;
let stops = 0;
let launcherFails = false;
let restoreStarter: (() => void) | null = null;
let restoreSignals: (() => void) | null = null;
let spies: Array<{ mockRestore(): void }> = [];
let output: string[] = [];
let peerNpub = "";
let exited = false;

beforeEach(async () => {
	box = sandbox();
	relay = await droppingListener();
	socks = await droppingListener();
	starts = 0;
	started = 0;
	stops = 0;
	launcherFails = false;
	exited = false;
	output = [];
	// A fake launcher: it never starts anything. Its proxy address is the listener above.
	restoreStarter = setTailscaleStarterForTests(async () => {
		starts += 1;
		if (launcherFails) {
			throw new Error("fake launcher: could not start");
		}
		started += 1;
		return {
			url: `socks5://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${socks.port}`,
			stop: async () => {
				stops += 1;
			},
		};
	});
	expect((await agx("identity", "new")).code).toBe(0);
	expect((await agx("config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
	// Nothing in these tests may reach the default relay address (ws://127.0.0.1:7447).
	expect(effectiveProfile("default").relays).toEqual([`ws://127.0.0.1:${relay.port}`]);
	peerNpub = toDisplayNpub(generateKeypair().publicKey);
});

afterEach(async () => {
	restoreSignals?.();
	restoreSignals = null;
	for (const spy of spies) {
		spy.mockRestore();
	}
	spies = [];
	restoreStarter?.();
	restoreStarter = null;
	await relay.close();
	await socks.close();
	box.restore();
});

async function storeTailscaleOptIn(): Promise<void> {
	const restore = setStdinForTests(KEY);
	try {
		const run = await agx("tailscale", "enable", "--auth-key-stdin", "--no-up");
		expect(run.code, run.stderr).toBe(0);
	} finally {
		restore();
	}
}

interface RunningUi {
	send(label: string): Promise<{ status: number; body: string }>;
	stop(): Promise<void>;
}

/** Run the real `agx ui` command in this process, with the shutdown and the browser left out. */
async function startUi(): Promise<RunningUi> {
	const before = { term: process.listeners("SIGTERM"), hup: process.listeners("SIGHUP"), int: process.listeners("SIGINT") };
	restoreSignals = () => {
		for (const [name, known] of [["SIGTERM", before.term], ["SIGHUP", before.hup], ["SIGINT", before.int]] as const) {
			for (const listener of process.listeners(name)) {
				if (!known.includes(listener)) {
					process.removeListener(name, listener as () => void);
				}
			}
		}
	};
	spies.push(
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(args.map(String).join(" "));
		}),
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			output.push(args.map(String).join(" "));
		}),
		vi.spyOn(process, "exit").mockImplementation((() => {
			exited = true;
		}) as never),
	);
	void uiCommand({ port: "0", open: false, idle: "0" }).catch((error: unknown) => {
		output.push(`uiCommand failed: ${String(error)}`);
	});
	const link = () => /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(output.join("\n"))?.[0];
	await until(() => link() !== undefined, "the ui link");
	const url = new URL(link() as string);
	const launch = await fetch(url);
	const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0] as string;
	const page = await fetch(`${url.origin}/`, { headers: { cookie } });
	const csrf = /name="csrf" content="([^"]+)"/.exec(await page.text())?.[1] as string;
	return {
		async send(label: string) {
			const text = `hello ${label}`;
			const response = await fetch(`${url.origin}/api/send`, {
				method: "POST",
				headers: { cookie, "x-agx-csrf": csrf, origin: url.origin, "content-type": "application/json" },
				body: JSON.stringify({ to: peerNpub, body: text, confirmedText: text, confirmedTo: peerNpub }),
			});
			return { status: response.status, body: await response.text() };
		},
		async stop() {
			process.emit("SIGINT");
			await until(() => exited, "the ui to shut down");
		},
	};
}

describe("agx ui and Tailscale", () => {
	it("pulls new messages through Tailscale when only the environment opts in", async () => {
		process.env.AGX_TAILSCALE = "1";
		process.env.AGX_TAILSCALE_AUTH_KEY = KEY;
		const ui = await startUi();
		await until(() => socks.connections > 0 || relay.connections > 0, "the first pull to reach a relay");
		expect(relay.connections, "the first pull dialled the relay directly").toBe(0);
		expect(socks.connections).toBeGreaterThan(0);
		expect(starts).toBe(1);
		await ui.stop();
		expect(stops).toBe(starts);
	});

	it("pulls new messages directly when the environment opts out of a stored opt-in", async () => {
		await storeTailscaleOptIn();
		process.env.AGX_TAILSCALE = "0";
		const ui = await startUi();
		await until(() => socks.connections > 0 || relay.connections > 0, "the first pull to reach a relay");
		expect(starts, "a launcher was started although the environment opted out").toBe(0);
		expect(socks.connections).toBe(0);
		expect(relay.connections).toBeGreaterThan(0);
		await ui.stop();
	});

	it("uses one launcher for pulling and for sending", async () => {
		await storeTailscaleOptIn();
		const ui = await startUi();
		await until(() => socks.connections > 0, "the first pull to reach the proxy");
		const sent = await ui.send("one");
		expect(sent.status, sent.body).toBe(502);
		await ui.send("two");
		expect(starts, "launchers started").toBe(1);
		expect(relay.connections, "direct relay connections").toBe(0);
		await ui.stop();
		expect(stops, "launchers stopped").toBe(starts);
	});

	it("waits a while after a failed start, then tries the launcher again", async () => {
		await storeTailscaleOptIn();
		launcherFails = true;
		// Only the clock the pause is measured with; the servers keep real time.
		vi.useFakeTimers({ toFake: ["performance"] });
		try {
			const ui = await startUi();
			await until(() => starts > 0, "the first start attempt");
			const failed = await ui.send("one");
			expect(failed.status).toBe(502);
			launcherFails = false;
			const startsBefore = starts;
			const early = await ui.send("two");
			expect(early.status).toBe(502);
			expect(starts, "the launcher was started again inside the pause").toBe(startsBefore);
			vi.advanceTimersByTime(30_000);
			const retried = await ui.send("three");
			expect(starts, "a send after the pause did not start the launcher").toBe(startsBefore + 1);
			expect(retried.status, retried.body).toBe(502);
			await ui.stop();
			expect(stops, "every launcher that started was stopped").toBe(started);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("agx ui when Tailscale cannot start", () => {
	it("tells the person Tailscale is not available and when the next try is, without the launcher's own words", async () => {
		await storeTailscaleOptIn();
		launcherFails = true;
		vi.useFakeTimers({ toFake: ["performance"] });
		try {
			const ui = await startUi();
			await until(() => starts > 0, "the first start attempt");
			const first = await ui.send("one");
			expect(first.status, first.body).toBe(502);
			const error = (JSON.parse(first.body) as { error: { code: string; message: string } }).error;
			expect(error.code).toBe("send_failed");
			expect(error.message).toMatch(/Tailscale is not available/);
			expect(error.message).toMatch(/about 30 seconds/);

			vi.advanceTimersByTime(12_500);
			const later = await ui.send("two");
			expect(later.status, later.body).toBe(502);
			expect((JSON.parse(later.body) as { error: { message: string } }).error.message).toMatch(/about 18 seconds/);

			for (const text of [first.body, later.body]) {
				expect(text).not.toContain("fake launcher");
				expect(text).not.toContain(KEY);
				expect(text).not.toContain(PROXY_USER);
				expect(text).not.toContain(PROXY_PASS);
			}
			await ui.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("agx ui when the transport cannot start for a reason other than Tailscale", () => {
	it("does not blame Tailscale and leaves the answer as it was", async () => {
		// No relays configured: the transport refuses to start, and Tailscale is not involved.
		updateProfile("default", { relays: [] });
		const ui = await startUi();
		const sent = await ui.send("one");
		expect(sent.status, sent.body).toBe(500);
		expect(sent.body).not.toMatch(/Tailscale/);
		expect(starts).toBe(0);
		await ui.stop();
	});
});

describe("agx ui and the relay from the environment", () => {
	it("pulls from, and checks, the relay the environment names rather than the stored one", async () => {
		const stored = await droppingListener();
		try {
			expect((await agx("config", "set", "relays", `ws://127.0.0.1:${stored.port}`)).code).toBe(0);
			process.env.AGX_RELAY = `ws://127.0.0.1:${relay.port}`;
			expect(effectiveProfile("default").relays).toEqual([`ws://127.0.0.1:${relay.port}`]);
			const ui = await startUi();
			// The first pull, then the reachability check that follows it.
			await until(() => stored.connections > 0 || relay.connections >= 2, "the first pull and its reachability check");
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(stored.connections, "the stored relay was dialled although the environment names another").toBe(0);
			expect(relay.connections).toBeGreaterThanOrEqual(2);
			await ui.stop();
		} finally {
			await stored.close();
		}
	});
});

describe("agx ui without Tailscale", () => {
	it("pulls and sends directly and starts no launcher", async () => {
		const ui = await startUi();
		await until(() => relay.connections > 0, "the first pull to reach the relay");
		const sent = await ui.send("one");
		expect(sent.status, sent.body).toBe(502);
		expect(starts).toBe(0);
		expect(socks.connections).toBe(0);
		await ui.stop();
		expect(stops).toBe(0);
	});
});
