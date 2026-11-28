import dns from "node:dns";
import { lookup as namedLookup } from "node:dns/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createServer, Server as HttpServer } from "node:http";
import net, { type AddressInfo } from "node:net";
import { Command, CommanderError } from "commander";
import { nip19 } from "nostr-tools";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@nostr-agx/nostr";
import { effectiveProfile, getProfile, updateProfile } from "../lib/config.js";
import { setCredential } from "../lib/credentials.js";
import { saveIdentity } from "../lib/identity.js";
import { redactSecrets, rememberSecret } from "../lib/secrets.js";
import { startGateway } from "../lib/gateway/gateway.js";
import { assertWebhookHost } from "../lib/gateway/subscriptions.js";
import { createGatewayKey } from "../lib/gateway/keys.js";
import { setStdinForTests } from "../lib/stdin.js";
import { setTailscaleSdkLoaderForTests } from "../lib/tailscale/index.js";
import { buildProgram, reportCliError, runCli } from "../program.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import {
	blockedReason,
	type CommandNode,
	changedSince,
	type ConnectAttempt,
	FORBIDDEN_PORTS,
	FORM_DESCRIPTION,
	FORMS,
	type Form,
	forbidPortForTest,
	guardConnections,
	countKey,
	holdsKey,
	listenPortOf,
	mask,
	percentEscapeAll,
	plant,
	type Planted,
	readTree,
	type SlotInfo,
	type TreeListing,
	walkProgram,
	WINDOW,
} from "./canary-kit.js";
import { capture, sandbox } from "./helpers.js";
import { type MockIndexServer, startMockIndexServer } from "./mock-index-server.js";

/**
 * The secret-key canary.
 *
 * A secret key pasted into the wrong place must not come back out: not on the
 * screen, not in a request, not in a file name or a file. This test walks every
 * command, option and positional that `buildProgram()` declares, pastes a
 * throwaway key into each one in every form listed in `canary-kit.ts` (and into
 * the slots that are not options at all: an unknown command, an unknown option,
 * a surplus argument, standard input, the `--profile` name), runs the real
 * program in this process and looks for any 10-character stretch of the key in
 * everything the run left behind. The gateway's HTTP API gets the same
 * treatment, one request per slot (a path, a header, a field of the body).
 *
 * It is a ratchet. `main` still has places that repeat a key, so they are written
 * down in KNOWN_LEAKS, with the reason each is there. The test fails when
 *   - a slot leaks that is not listed (a new leak), or
 *   - a listed slot no longer leaks (remove the entry: it is fixed), or
 *   - a command, option or positional is not in the slot table (classify it).
 * So the list only ever gets shorter, and a fix is done when its entries are gone.
 * INTENDED lists the few slots whose job is to take a secret and keep it.
 *
 * Nothing leaves this machine: a guard refuses every connection that is not to
 * 127.0.0.1 or to a port that is never to be used, the relay is the in-process
 * one and the index is the in-process mock.
 *
 * The whole matrix takes a few minutes. To work on one command, run only it:
 * `CANARY_ONLY=search pnpm exec vitest run src/test/secret-canary.test.ts`
 * (every command whose name starts with the text is run and checked against the lists;
 * several texts go in one value, separated by commas).
 */

// ===================================================================== slot table

/**
 * Four classes of slot, as the plan names them (secret, public key, identifier,
 * free text), plus the identifier-like values that have a shape of their own. A
 * class says what an ordinary, valid value looks like (so the other slots of the
 * command are filled with something that works) and what the slot is for.
 */
type Kind = "secret" | "pubkey" | "id" | "text" | "number" | "duration" | "url" | "relay" | "path" | "json" | "choice";

interface Spec {
	kind: Kind;
	/** A fixed valid value for this slot, when the class's default is not accepted. */
	fill?: string;
	/** A flag that reads the slot's value from standard input instead of the command line. */
	stdin?: true;
	/** Other slots whose value changes what this slot means: the probe is run once for each. */
	vary?: Record<string, string>[];
	/** Arguments this slot only does anything with (`--new-org`, `--domain-id d1`), added to every probe of it. */
	with?: string[];
	/** Other slots and base arguments (by name) that are left out when this one is probed, because they cannot go with it. */
	without?: string[];
	/** A value that is not valid here makes the command wait for ever: stop watching it after a moment. */
	waits?: true;
	/**
	 * Why the probe cannot show that the command used this slot (it stops before it, or what it does with
	 * the value is not seen anywhere). Only for a slot that would otherwise pass as clean without proof.
	 */
	unproven?: string;
}

interface CommandEntry {
	slots: Record<string, Kind | Spec>;
	/** Arguments every probe of the command carries so it ends quickly and stays on this machine. */
	base?: string[];
	/** The command starts a server and runs until Ctrl-C: the probe stops it the way Ctrl-C would. */
	listens?: true;
	/** The profile has to be in a state the command needs before it does anything. */
	opted?: "tailscale";
	/** The same for `--profile`: why the command's use of the profile name is not seen (see `unproven` on a slot). */
	profileUnproven?: string;
}

/** In `base` and `with`: the public key of the peer that every probe knows. */
const PEER = "<peer>";

// Why a slot's clean result is not backed by proof that the command used it (`unproven`).
const NO_MESSAGE = "it matters when a message arrives, and the probe sends none";
const NO_PROFILE_READ = "the command does not read a profile name";
const SAME_ANSWER = "the command uses the profile name, but a profile that does not exist and the default one (empty here) give the same answer";

const REGISTER_SLOTS: CommandEntry["slots"] = {
	"--slug": { kind: "id", fill: "demo-agent" },
	"--display-name": "text",
	"--org": "id",
	"--capability": "id",
	"--summary": "text",
	"--description": "text",
	"--use-cases": "text",
	"--category": "id",
	"--tag": "id",
	"--runtime": "text",
	"--visibility": "choice",
	"--handle": { kind: "id", with: ["--domain-id", "domain-1"] },
	"--domain-id": "id",
};

const CONFIG_KEYS = ["apiKey", "apiBaseUrl", "orgSlug", "relays", "org", "nip05"];

/**
 * Every command, with a class for every slot that takes a value. A flag that takes
 * no value has nothing to paste into and is not listed, except the three flags
 * that read standard input (`stdin: true`). The test fails for a command, option
 * or positional that is missing here, and for an entry that no longer exists.
 */
const SLOT_TABLE: Record<string, CommandEntry> = {
	"(program)": { slots: { "--profile": "id" } },
	login: {
		slots: {
			"--api-base-url": "url",
			"--org": "id",
			"--org-name": { kind: "text", with: ["--new-org"] },
			"--org-slug": { kind: "id", with: ["--new-org"] },
		},
		base: ["--no-browser", "--no-wait"],
	},
	logout: { slots: {} },
	whoami: { slots: {} },
	org: { slots: {} },
	"org list": { slots: {} },
	"org create": {
		slots: { "<name>": "text", "--slug": "id", "--api-base-url": "url" },
		base: ["--no-browser", "--no-wait"],
	},
	config: { slots: {} },
	"config show": { slots: {} },
	"config set": {
		slots: {
			"<key>": { kind: "id", fill: "orgSlug" },
			"[value]": { kind: "text", vary: CONFIG_KEYS.map((key) => ({ "<key>": key })) },
			"--stdin": { kind: "secret", stdin: true, without: ["[value]"], vary: CONFIG_KEYS.map((key) => ({ "<key>": key })) },
		},
	},
	"config use": { slots: { "<profile>": "id" }, profileUnproven: NO_PROFILE_READ },
	"config list": { slots: {}, profileUnproven: NO_PROFILE_READ },
	"config path": { slots: {}, profileUnproven: NO_PROFILE_READ },
	identity: { slots: {} },
	"identity new": { slots: {} },
	"identity show": { slots: {} },
	// A key that is accepted, so the other probes of the command get as far as the profile they are about.
	"identity import": { slots: { "[secret]": { kind: "secret", fill: plant("nsec", "import-fill").value }, "--stdin": { kind: "secret", stdin: true, without: ["[secret]"] }, "--from-env": { kind: "id", without: ["[secret]"] } }, base: ["--force"] },
	"identity export": { slots: {} },
	"identity sign": { slots: { "<nonce>": "text" } },
	"identity allow": { slots: { "[peers...]": "pubkey" } },
	"identity deny": { slots: { "<peers...>": "pubkey" } },
	"identity register": { slots: REGISTER_SLOTS },
	register: { slots: REGISTER_SLOTS },
	listing: { slots: {} },
	"listing create": {
		slots: {
			"--slug": { kind: "id", fill: "demo-agent" },
			"--team": { kind: "id", without: ["--pubkey"] },
			"--pubkey": "pubkey",
			"--display-name": "text",
			"--capability": "id",
			"--summary": "text",
			"--description": "text",
			"--category": "id",
			"--tag": "id",
			"--runtime": "text",
			"--visibility": "choice",
			"--handle": { kind: "id", with: ["--domain-id", "domain-1"] },
			"--domain-id": "id",
			"--relay": "relay",
			"--org": "id",
		},
		base: ["--pubkey", PEER],
	},
	"listing list": { slots: { "--org": "id", "--limit": "number" } },
	"listing get": { slots: { "[listingId]": "id", "--org": "id" } },
	"listing publish": {
		slots: {
			"[listingId]": "id",
			"--org": "id",
			"--visibility": "choice",
			"--timeout": { kind: "duration", with: ["--wait"] },
		},
	},
	"listing set-visibility": { slots: { "<level>": { kind: "choice", fill: "public" }, "[listingId]": "id", "--org": "id" } },
	"listing delist": { slots: { "[listingId]": "id", "--org": "id" } },
	"listing delete": { slots: { "[listingId]": "id", "--org": "id" }, base: ["--yes"] },
	"listing set-policy": {
		slots: { "[listingId]": "id", "--org": "id", "--capability": "id", "--daily-cap": "number" },
		base: ["--auto-allow"],
	},
	domain: { slots: {} },
	"domain add": { slots: { "<domain>": { kind: "id", fill: "example.com" }, "--handle": "id", "--org": "id" } },
	"domain list": { slots: { "--org": "id" } },
	"domain verify": { slots: { "<domainId>": "id", "--timeout": { kind: "duration", with: ["--wait"] }, "--org": "id" } },
	"domain remove": { slots: { "<domainId>": "id", "--org": "id" }, base: ["--yes"] },
	search: {
		slots: {
			"[query]": "text",
			"--org": "id",
			"--capability": "id",
			"--category": "id",
			"--limit": "number",
			"--offset": "number",
		},
	},
	peers: { slots: {} },
	"peers list": { slots: { "--team": "id", "--org": "id" } },
	"peers allowlist": { slots: { "--team": "id", "--npub": "pubkey", "--name": "text", "--org": "id" } },
	"peers accept": { slots: { "--team": "id", "--peer": "id", "--reason": "text", "--org": "id" } },
	"peers refuse": { slots: { "--team": "id", "--peer": "id", "--reason": "text", "--org": "id" }, base: ["--reason", "no"] },
	"peers ignore": { slots: { "--team": "id", "--peer": "id", "--reason": "text", "--org": "id" } },
	"peers block": { slots: { "--team": "id", "--peer": "id", "--reason": "text", "--org": "id" } },
	serve: {
		slots: {
			"--allow": "pubkey",
			"--capability": "id",
			"--handler": "path",
			"--poll-interval": { kind: "number", unproven: "`--once` stops after one pass, so the pause between passes never comes" },
			"--max-auto-depth": { kind: "number", unproven: NO_MESSAGE },
			"--reply-text": { kind: "text", unproven: NO_MESSAGE },
		},
		base: ["--once"],
	},
	gateway: {
		slots: {
			"--host": { kind: "id", fill: "127.0.0.1" },
			"--port": { kind: "number", fill: "0" },
			"--poll-interval": { kind: "number", fill: "500", unproven: "the probe stops the gateway as soon as it is up, before anything is polled" },
		},
		base: ["--port", "0"],
		listens: true,
	},
	"gateway key": { slots: {} },
	"gateway key new": { slots: { "--label": "text" } },
	"gateway key list": { slots: {}, profileUnproven: SAME_ANSWER },
	"gateway key revoke": { slots: { "<id>": "id" }, profileUnproven: SAME_ANSWER },
	inbox: { slots: { "--wait": "number", "--thread": { kind: "id", unproven: "the inbox holds no message, so every thread id gets the same empty answer" } }, base: ["--wait", "1"] },
	wait: { slots: { "--timeout": "number" }, base: ["--timeout", "1"] },
	held: { slots: {} },
	"held list": { slots: {}, profileUnproven: SAME_ANSWER },
	"held allow": { slots: { "<npub>": "pubkey" } },
	"held ignore": { slots: { "<npub>": "pubkey" } },
	"held block": { slots: { "<npub>": "pubkey" } },
	threads: { slots: {}, profileUnproven: SAME_ANSWER },
	thread: { slots: { "<contextId>": "id" }, profileUnproven: SAME_ANSWER },
	send: { slots: { "<peer>": "pubkey", "<message>": "text", "--subject": "text", "--context-id": "id" } },
	ui: {
		slots: {
			"--port": { kind: "number", fill: "0" },
			"--compose": "path",
			"--drafts": { kind: "path", unproven: "the folder is read when the UI is asked for a draft, and the probe sends the UI no request" },
			"--idle": "number",
			"--dev-store": { kind: "path", unproven: "refused unless AGX_UI_DEV_STORE=1, which is for tests only" },
		},
		base: ["--no-open"],
		listens: true,
	},
	request: {
		slots: {
			"<peer>": "pubkey",
			"<capability>": "id",
			"--payload": "json",
			"--timeout": { kind: "number", fill: "300", waits: true, unproven: "the command waits for a reply that never comes, and the probe stops watching after 1.5 seconds" },
		},
		base: ["--timeout", "300"],
	},
	card: { slots: { "<peer>": "pubkey", "--relay": "relay" }, profileUnproven: SAME_ANSWER },
	relay: {
		slots: {
			"--port": { kind: "number", fill: "0" },
			"--tls-port": { kind: "number", fill: "0", unproven: "used only with --tls, which makes a certificate with openssl and is never passed" },
		},
		base: ["--port", "0"],
		listens: true,
		profileUnproven: NO_PROFILE_READ,
	},
	tailscale: { slots: {} },
	"tailscale enable": {
		slots: {
			"--auth-key": "secret",
			"--auth-key-stdin": { kind: "secret", stdin: true },
			"--oauth-url": "url",
			"--oauth-client-id": "id",
			"--oauth-client-secret": "secret",
			"--oauth-client-secret-stdin": { kind: "secret", stdin: true },
			"--oauth-scope": "text",
			"--oauth-tailnet": "id",
			"--oauth-token-auth": "choice",
			"--oauth-api-base-url": "url",
			"--tag": "id",
			"--hostname": "id",
			"--state-dir": "path",
		},
		base: ["--no-up"],
	},
	"tailscale up": {
		slots: {
			"--auth-key": { kind: "secret", unproven: "read, and then the command stops: the Tailscale package is replaced by one that fails, so no node is started" },
			"--auth-key-stdin": { kind: "secret", stdin: true, unproven: "read, and then the command stops: the Tailscale package is replaced by one that fails, so no node is started" },
			"--hostname": "id",
			"--state-dir": "path",
		},
		opted: "tailscale",
	},
	"tailscale status": { slots: {} },
	"tailscale disable": { slots: {} },
	doctor: { slots: {} },
};

// ====================================================================== the world

/** What every probe shares: an index, a relay and a peer, all on this machine. */
interface World {
	index: MockIndexServer;
	indexKey: string;
	relay: RunningRelay;
	relayUrl: string;
	relayLog: string[];
	peerNpub: string;
	attempts: ConnectAttempt[];
}

let world: World;
let startedIn = "";
let restoreGuard: () => void;
let restoreTailscale: () => void;
let restoreWebSocket: () => void = () => undefined;

function fillOf(slot: SlotInfo, spec: Spec, home: string): string {
	if (spec.fill !== undefined) {
		return spec.fill;
	}
	switch (spec.kind) {
		case "secret":
			return "throwaway-secret";
		case "pubkey":
			return world.peerNpub;
		case "id":
			return "demo-1";
		case "text":
			return "hello";
		case "number":
			return "1";
		case "duration":
			return "1m";
		case "url":
			return world.index.origin;
		case "relay":
			return "wss://relay.example.com";
		case "path":
			return join(home, "input.json");
		case "json":
			return "{}";
		case "choice":
			return slot.choices?.[0] ?? "x";
	}
}

function specOf(value: Kind | Spec): Spec {
	return typeof value === "string" ? { kind: value } : value;
}

// ==================================================================== the probes

/** What a probe plants a key into. */
type Target =
	| { type: "slot"; slot: SlotInfo; spec: Spec; vary: Record<string, string> | null }
	| { type: "profile" }
	| { type: "unknown-option" }
	| { type: "extra-argument" }
	| { type: "unknown-subcommand" }
	| { type: "unknown-command" }
	| { type: "help-argument" };

interface Plan {
	command: string;
	slot: string;
	node: CommandNode;
	target: Target;
}

function label(target: Target, vary: Record<string, string> | null): string {
	switch (target.type) {
		case "slot": {
			const suffix = vary ? ` (${Object.entries(vary).map(([k, v]) => `${k.replace(/[<>]/g, "")}=${v}`).join(", ")})` : "";
			return `${target.slot.name}${target.spec.stdin ? " (stdin)" : ""}${suffix}`;
		}
		case "profile":
			return "--profile";
		case "unknown-option":
			return "<unknown option>";
		case "extra-argument":
			return "<extra argument>";
		case "unknown-subcommand":
			return "<unknown subcommand>";
		case "unknown-command":
			return "<unknown command>";
		case "help-argument":
			return "<help argument>";
	}
}

/** The command line for a probe, and what is piped in. */
function lineFor(plan: Plan, planted: string, home: string, json: boolean): { args: string[]; stdin: string | null } {
	const entry = SLOT_TABLE[plan.command] as CommandEntry;
	const node = plan.node;
	const target = plan.target;
	const front: string[] = json ? ["--json"] : [];
	if (target.type === "unknown-command") {
		return { args: [...front, planted], stdin: null };
	}
	if (target.type === "help-argument") {
		return { args: [...front, "help", planted], stdin: null };
	}
	if (target.type === "profile") {
		front.push("--profile", planted);
	}
	const slotted = target.type === "slot" ? target.slot : null;
	const arguments_ = node.slots.filter((slot) => slot.kind === "argument");
	const options = node.slots.filter((slot) => slot.kind === "option" && slot.takesValue);
	const vary = target.type === "slot" ? target.vary : null;
	const without = new Set(target.type === "slot" ? (target.spec.without ?? []) : []);

	// Every positional is filled, optional ones too: a command that was not given one
	// may stop before it uses the slot being probed. Only the slot itself changes.
	const positional: string[] = [];
	for (const slot of arguments_) {
		const spec = specOf(entry.slots[slot.name] ?? "text");
		if (slot === slotted) {
			positional.push(planted);
		} else if (vary && slot.name in vary) {
			positional.push(vary[slot.name] as string);
		} else if (!without.has(slot.name)) {
			positional.push(fillOf(slot, spec, home));
		}
	}
	if (target.type === "extra-argument") {
		positional.push(planted);
	}

	const optionTokens: string[] = [];
	for (const slot of options) {
		if (slot === slotted) {
			optionTokens.push(slot.name, planted);
		} else if (slot.required && !without.has(slot.name)) {
			optionTokens.push(slot.name, fillOf(slot, specOf(entry.slots[slot.name] ?? "text"), home));
		}
	}

	// The command's own base arguments, minus any option the probe is planting into.
	const base: string[] = [];
	const known = new Map(node.slots.map((slot) => [slot.name, slot]));
	for (let i = 0; i < (entry.base?.length ?? 0); i++) {
		const token = (entry.base as string[])[i] as string;
		const info = known.get(token);
		if (info && ((slotted && info.name === slotted.name) || without.has(info.name))) {
			i += info.takesValue ? 1 : 0;
			continue;
		}
		base.push(token);
		if (info?.takesValue) {
			base.push((entry.base as string[])[++i] as string);
		}
	}

	const tail: string[] = [];
	let stdin: string | null = null;
	if (target.type === "unknown-option") {
		tail.push(`--${planted}`);
	}
	if (target.type === "slot" && target.spec.stdin) {
		tail.push(target.slot.name);
		stdin = planted;
	}
	if (target.type === "slot" && target.spec.with) {
		tail.push(...target.spec.with);
	}
	const peerFor = (token: string): string => (token === PEER ? world.peerNpub : token);
	if (target.type === "unknown-subcommand") {
		return { args: [...front, ...node.path, planted], stdin: null };
	}
	return { args: [...front, ...node.path, ...positional, ...optionTokens, ...base, ...tail].map(peerFor), stdin };
}

// ------------------------------------------------------------- channels and runs

const CHANNELS = [
	"stdout",
	"stderr",
	"json-stdout",
	"json-stderr",
	"request",
	"relay",
	"file-name",
	"file-content",
	"connect",
	"response",
	"log",
] as const;
type Channel = (typeof CHANNELS)[number];

interface Observed {
	code: number | null;
	threw: string | null;
	/** The command was still waiting when watching stopped (only for a slot marked `waits`). */
	abandoned: boolean;
	/** Channels in which a stretch of the key was found. */
	channels: Set<Channel>;
	millis: number;
	/** What the guard stopped on a forbidden port. */
	forbidden: ConnectAttempt[];
	/** Everything the run showed, with the random folder names taken out: two runs that did the same have the same summary. */
	summary: string;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type Handler = (...args: unknown[]) => unknown;

function signalHandlers(): Map<string, Handler[]> {
	return new Map(SIGNALS.map((signal) => [signal, process.listeners(signal) as Handler[]]));
}

/** The signal handlers a run added, in order. */
function addedHandlers(before: Map<string, Handler[]>): Array<[string, Handler]> {
	const added: Array<[string, Handler]> = [];
	for (const signal of SIGNALS) {
		const known = new Set(before.get(signal));
		for (const handler of process.listeners(signal) as Handler[]) {
			if (!known.has(handler)) {
				added.push([signal, handler]);
			}
		}
	}
	return added;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Finished = { code: number } | { error: string };

/**
 * Run the program. A command that serves (`listens`) is stopped the way Ctrl-C
 * stops it: through the signal handlers it registered, once it is up. Nothing is
 * signalled for real, and `process.exit` is recorded, never carried out.
 */
async function drive(run: Promise<number>, listens: boolean, before: Map<string, Handler[]>, exits: number[], patience = 15_000): Promise<Finished | null> {
	let finished: Finished | null = null;
	void run.then(
		(code) => {
			finished = { code };
		},
		(error: unknown) => {
			finished = { error: error instanceof Error ? error.message : String(error) };
		},
	);
	if (listens) {
		const deadline = Date.now() + patience;
		while (finished === null && addedHandlers(before).length === 0 && Date.now() < deadline) {
			await pause(5);
		}
		await pause(40);
		const handlers = addedHandlers(before);
		for (const [, handler] of handlers) {
			await Promise.resolve(handler());
		}
		const stopBy = Date.now() + Math.min(patience, 5_000);
		while (finished === null && exits.length === 0 && Date.now() < stopBy) {
			await pause(5);
		}
		// Neither ended by itself nor stopped by its signal handlers: it would be left running.
		if (finished === null && exits.length === 0) {
			return { error: `the command is still running and has not stopped on a signal${handlers.length === 0 ? " (it registered no handler)" : ""}` };
		}
	} else {
		await run.catch(() => undefined);
	}
	return finished;
}

/** One run of `args` in a fresh home; looks for `planted` everywhere it could have gone. */
async function runOnce(
	lineFor: (home: string) => { args: string[]; stdin: string | null },
	planted: Planted,
	json: boolean,
	options: {
		listens?: boolean;
		waits?: boolean;
		keeps?: boolean;
		opted?: CommandEntry["opted"];
		run?: (args: string[]) => Promise<number>;
		/** Milliseconds a command may take (and a server may take to stop); the controls make it short. */
		deadline?: number;
		/** Runs after the profile is set up and before the relay pin is checked: the controls break the pin here. */
		afterSetup?: () => void;
	} = {},
): Promise<Observed> {
	const run = options.run ?? runCli;
	const started = performance.now();
	const box = sandbox();
	homesMade.push(box.home);
	let scratch = "";
	let restoreStdin = (): void => undefined;
	const cwd = process.cwd();
	try {
		// What a command writes under the temp directory lands here (and is looked through), not next to somebody's files.
		scratch = mkdtempSync(join(tmpdir(), "agx-canary-tmp-"));
		homesMade.push(scratch);
		process.env.TMPDIR = scratch;
		pointHomeAt(box.home);
		const { args, stdin } = lineFor(box.home);
		restoreStdin = setStdinForTests(stdin);
		const requestsBefore = world.index.requests.length;
		const relayBefore = world.relayLog.length;
		const attemptsBefore = world.attempts.length;
		// A relative path a command is given lands in the throwaway home, not in the repository.
		process.chdir(box.home);
		saveIdentity("default", planted.identity);
		updateProfile("default", { apiBaseUrl: world.index.origin, orgSlug: "acme", relays: [world.relayUrl] });
		setCredential("default", {
			apiBaseUrl: world.index.origin,
			apiKey: world.indexKey,
			apiKeyId: null,
			source: "manual",
			clientId: null,
			organization: null,
			user: null,
			scopes: null,
			expiresAt: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		process.env.AGX_API_URL = world.index.origin;
		process.env.AGX_RELAY = world.relayUrl;
		world.relay.clear();
		if (options.opted === "tailscale") {
			updateProfile("default", { tailscale: { ...getProfile("default").tailscale, enabled: true } });
		}
		options.afterSetup?.();
		assertRelayPinned(args);

		let code: number | null = null;
		let threw: string | null = null;
		const exits: number[] = [];
		const before = signalHandlers();
		// Timers a command starts and never stops (a lock heartbeat, say) must not outlive its run.
		const intervals: NodeJS.Timeout[] = [];
		const startInterval = globalThis.setInterval;
		const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
			const handle = startInterval(...args);
			intervals.push(handle);
			return handle;
		}) as typeof setInterval);
		let abandoned = false;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((exitCode?: number) => {
			exits.push(exitCode ?? 0);
			return undefined as never;
		}) as never);
		const { stdout, stderr } = await capture(async () => {
			try {
				const limit = options.deadline ?? (options.waits ? WAITS_MS : 30_000);
				const finished = await withDeadline(drive(run(args), options.listens === true, before, exits, options.deadline === undefined ? undefined : Math.floor(options.deadline / 4)), limit, args);
				if (finished && "code" in finished) {
					code = finished.code;
				} else if (finished) {
					threw = finished.error;
				}
			} catch (error) {
				if (options.waits && error instanceof Stuck) {
					abandoned = true;
				} else {
					threw = error instanceof Error ? error.message : String(error);
				}
			}
			return null;
		});
		exitSpy.mockRestore();
		intervalSpy.mockRestore();
		for (const handle of intervals) {
			clearInterval(handle);
		}
		for (const [signal, handler] of addedHandlers(before)) {
			process.removeListener(signal, handler);
		}
		if (exits.some((exitCode) => exitCode !== 0)) {
			threw ??= `process.exit(${exits.join(",")}) was called`;
		}

		const own = planted.form === "hex" || planted.form === "HEX";
		// The redactor only knows what a command told it to remember. A stranger's key in there would hide leaks from this test.
		// (`config set apiKey` hands its value to the redactor on purpose: that is what an API key is for.)
		if (!own && !options.keeps && redactSecrets(planted.value) !== planted.value) {
			threw ??= "the program remembered the planted key for redaction";
		}
		const home = readTree(box.home, own ? new Set(["profiles/default/identity.json"]) : new Set());
		const temp = readTree(scratch);
		const tree = { names: `${home.names}\n${temp.names}`, contents: `${home.contents}\n${temp.contents}` };
		const requests = world.index.requests
			.slice(requestsBefore)
			.map((r) => `${r.method} ${r.path}${r.search}\n${JSON.stringify(r.headers)}\n${typeof r.body === "string" ? r.body : JSON.stringify(r.body)}`)
			.join("\n");
		const attempts = world.attempts.slice(attemptsBefore);
		const texts: Record<Channel, string> = {
			stdout: json ? "" : stdout,
			stderr: json ? "" : stderr,
			"json-stdout": json ? stdout : "",
			"json-stderr": json ? stderr : "",
			request: requests,
			relay: world.relayLog.slice(relayBefore).join("\n"),
			"file-name": tree.names,
			"file-content": tree.contents,
			connect: attempts.map((a) => `${a.host}:${a.port}`).join("\n"),
			response: "",
			log: "",
		};
		const channels = new Set<Channel>();
		for (const channel of CHANNELS) {
			if (holdsKey(texts[channel], planted.needles)) {
				channels.add(channel);
			}
		}
		// What differs from one run to the next without anybody asking for it: folders, times, ports, counters, and whether a connection was reused.
		const { connect: _connect, ...shown } = texts;
		const summary = JSON.stringify({ code, abandoned, shown })
			.split(box.home)
			.join("<home>")
			.split(scratch)
			.join("<tmp>")
			.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>")
			.replace(/\d{4,}/g, "<n>");
		return { code, threw, abandoned, channels, millis: performance.now() - started, forbidden: attempts.filter((a) => a.blocked === "port"), summary };
	} finally {
		restoreStdin();
		process.chdir(cwd);
		box.restore();
		if (scratch !== "") {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
}

/**
 * The stock profile's relay is ws://127.0.0.1:7447, somebody's own. Every profile
 * a command can name must resolve to the throwaway relay, or the run does not start.
 */
function assertRelayPinned(args: string[]): void {
	const named = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : undefined;
	for (const name of new Set(["default", ...(named ? [named] : [])])) {
		let relays: string[] = [];
		try {
			relays = effectiveProfile(name).relays;
		} catch {
			continue; // a name that is not a profile name: the command refuses it before it can connect
		}
		if (relays.length !== 1 || relays[0] !== world.relayUrl) {
			throw new Error(`the throwaway home does not pin the relay for profile "${name.length > 24 ? mask(name) : name}": ${relays.join(", ")}`);
		}
	}
}

/**
 * The places a program takes for "the user's home" and its settings. All of them are inside the throwaway
 * home, so a program that writes under `~/.claude` or `~/.config` lands where it is looked through, and
 * not in the files of the person running the test.
 */
const HOME_VARIABLES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

/** Names of variables that say where a home, a settings folder or a temporary folder is. */
const HOME_LIKE = /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_[A-Z_]+|[A-Z_]*CONFIG_DIR|[A-Z_]*_HOME|TMPDIR|TMP|TEMP)$/;

function pointHomeAt(home: string): void {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.XDG_CONFIG_HOME = join(home, ".config");
	process.env.XDG_DATA_HOME = join(home, ".local", "share");
	process.env.XDG_CACHE_HOME = join(home, ".cache");
	process.env.XDG_STATE_HOME = join(home, ".local", "state");
	process.env.APPDATA = join(home, "AppData", "Roaming");
	process.env.LOCALAPPDATA = join(home, "AppData", "Local");
	process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
	process.env.CODEX_HOME = join(home, ".codex");
	// A real Tailscale key in the environment would be the one the command reads.
	delete process.env.TS_AUTHKEY;
}

/** Every source file of the packages the program is made of, apart from tests, and the folder `packages` is in. */
function sourceFiles(): { root: string; files: string[] } {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "test" && entry.name !== "node_modules") {
					walk(path);
				}
			} else if (/\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name)) {
				files.push(path);
			}
		}
	};
	for (const pkg of ["cli", "nostr", "core"]) {
		walk(join(root, pkg, "src"));
	}
	files.sort();
	if (files.length < 50) {
		throw new Error(`found ${files.length} source files under ${root}: the folders have moved`);
	}
	return { root, files };
}

/** Does this source text import `node:dns` or call a resolver (`dns.resolve*`, `Resolver`), which the connection guard does not watch? */
function usesResolver(text: string): boolean {
	return /\bnew (?:dns\.)?(?:promises\.)?Resolver\b|\bdns\.(?:promises\.)?resolve|\bresolve(?:4|6|Any|Srv|Txt|Mx|Cname|Ns)\(|["']node:dns["']|["']node:dns\/promises["']/.test(text);
}

/** Does this source text import `node:child_process`? */
function usesChildProcess(text: string): boolean {
	return /["']node:child_process["']/.test(text);
}

/** The home of the person running the test, as it is before any run changes it. */
const REAL_HOME = homedir();

/** Every throwaway home a run made: all must be gone when the matrix is done. */
const homesMade: string[] = [];

/**
 * Removes the folders this file made, and only those (never a pattern): when the file ends, when the process
 * ends, and when it is told to stop. A run that is killed in the middle would otherwise leave them behind.
 */
function removeMade(): void {
	for (const folder of homesMade) {
		rmSync(folder, { recursive: true, force: true });
	}
}

function removeMadeOnSignal(signal: NodeJS.Signals): void {
	removeMade();
	process.kill(process.pid, signal);
}

process.once("exit", removeMade);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.once(signal, () => removeMadeOnSignal(signal));
}

const WAITS_MS = 1_500;

class Stuck extends Error {}

/** A run that never ends is a failure of the harness, not a result: say which line stuck. */
async function withDeadline<T>(promise: Promise<T>, ms: number, args: string[]): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Stuck(`the command did not finish in ${ms} ms: agx ${args.map((a) => (a.length > 24 ? mask(a) : a)).join(" ")}`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------- the matrix plans

function plansFor(nodes: CommandNode[]): Plan[] {
	const plans: Plan[] = [];
	for (const node of nodes) {
		const entry = SLOT_TABLE[node.label];
		if (!entry) {
			continue;
		}
		const isProgram = node.path.length === 0;
		const runnable = !isProgram && (!node.hasSubcommands || node.slots.some((slot) => slot.takesValue));
		const add = (target: Target, vary: Record<string, string> | null = null): void => {
			plans.push({ command: node.label, slot: label(target, vary), node, target });
		};
		if (isProgram) {
			add({ type: "unknown-command" });
			add({ type: "help-argument" });
			continue;
		}
		for (const slot of node.slots) {
			const raw = entry.slots[slot.name];
			if (raw === undefined || (!slot.takesValue && !specOf(raw).stdin)) {
				continue;
			}
			const spec = specOf(raw);
			for (const vary of spec.vary ?? [null]) {
				add({ type: "slot", slot, spec, vary }, vary);
			}
		}
		if (runnable) {
			add({ type: "profile" });
		}
		add({ type: "unknown-option" });
		if (node.hasSubcommands) {
			add({ type: "unknown-subcommand" });
		} else if (!node.slots.some((slot) => slot.kind === "argument" && slot.variadic)) {
			add({ type: "extra-argument" });
		}
	}
	return plans;
}

// ====================================================================== the checks

/** Slots and commands that are in the program but not in the table, or the other way round. */
function unclassified(nodes: CommandNode[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const node of nodes) {
		seen.add(node.label);
		const entry = SLOT_TABLE[node.label];
		if (!entry) {
			const slots = node.slots.map((slot) => `${slot.name}${slot.takesValue ? " (takes a value)" : " (flag)"}`);
			problems.push(`command "${node.label}" is not in SLOT_TABLE; its slots: ${slots.length > 0 ? slots.join(", ") : "none"}`);
			continue;
		}
		const names = new Set(node.slots.map((slot) => slot.name));
		for (const slot of node.slots) {
			const raw = entry.slots[slot.name];
			if (slot.takesValue && raw === undefined) {
				problems.push(`"${node.label}" ${slot.name} takes a value and has no class in SLOT_TABLE`);
			}
			if (!slot.takesValue && raw !== undefined && !specOf(raw).stdin) {
				problems.push(`"${node.label}" ${slot.name} takes no value; list it only with stdin: true if it reads standard input`);
			}
		}
		for (const name of Object.keys(entry.slots)) {
			if (!names.has(name)) {
				problems.push(`SLOT_TABLE lists "${node.label}" ${name}, which the program no longer has`);
			}
		}
	}
	for (const label of Object.keys(SLOT_TABLE)) {
		if (!seen.has(label)) {
			problems.push(`SLOT_TABLE lists command "${label}", which the program no longer has`);
		}
	}
	return problems;
}

// ================================================================= the matrix run

interface Leak {
	command: string;
	slot: string;
	form: Form;
	channel: Channel;
}

interface MatrixResult {
	leaks: Leak[];
	probes: number;
	runs: number;
	millis: number;
	threw: string[];
	forbidden: string[];
	slow: Array<{ line: string; millis: number }>;
	slots: number;
	commands: number;
	/** `command | slot` of every run that was left waiting, once per slot. */
	abandoned: Set<string>;
	/** For every slot: did the command use what it was given? A leak says so; so does a marker that comes back. */
	reach: Array<{ command: string; slot: string; reached: boolean; reason: string | null }>;
}

// ================================================== the gateway's HTTP API

/**
 * `agx gateway` answers HTTP requests for n8n and other tools. Each probe is one
 * request with the key in one place (a path, a header, a field of the body); what
 * is watched is the answer, the lines the gateway logs, the relay, and the files
 * it changes. One gateway is started per key form, as the profile whose own key
 * the hex forms are.
 */
const GATEWAY_API = "gateway (HTTP API)";
const AFTER_STOP = "<saved when the gateway stops>";

interface HttpRequest {
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
}

interface HttpProbe {
	slot: string;
	send: (value: string, peer: string) => HttpRequest;
	/** Why the gateway's use of this field is not seen (see `unproven` on a slot). */
	unproven?: string;
}

const asJson = (value: unknown): string => JSON.stringify(value);
const here = (value: string): string => encodeURIComponent(value);

const HTTP_PROBES: HttpProbe[] = [
	{ slot: "POST /v1/tasks peer", send: (v) => ({ method: "POST", path: "/v1/tasks", body: asJson({ peer: v, capability: "demo.run", timeoutSec: 1 }) }) },
	{ slot: "POST /v1/tasks capability", send: (v, peer) => ({ method: "POST", path: "/v1/tasks", body: asJson({ peer, capability: v, timeoutSec: 1 }) }) },
	{ slot: "POST /v1/tasks payload", send: (v, peer) => ({ method: "POST", path: "/v1/tasks", body: asJson({ peer, capability: "demo.run", payload: { note: v }, timeoutSec: 1 }) }), unproven: "the payload is encrypted for the peer before it leaves, so the relay shows only ciphertext" },
	{ slot: "POST /v1/tasks Idempotency-Key", send: (v, peer) => ({ method: "POST", path: "/v1/tasks", headers: { "idempotency-key": v }, body: asJson({ peer, capability: "demo.run", timeoutSec: 1 }) }), unproven: "the gateway keeps only a SHA-256 hash of the key" },
	{ slot: "POST /v1/tasks (body)", send: (v) => ({ method: "POST", path: "/v1/tasks", body: v }), unproven: "a body that is not JSON is refused with a fixed message" },
	{ slot: "GET /v1/tasks/:id", send: (v) => ({ method: "GET", path: `/v1/tasks/${here(v)}` }), unproven: "an id that names no task gets the same answer as any other" },
	{ slot: "POST /v1/messages peer", send: (v) => ({ method: "POST", path: "/v1/messages", body: asJson({ peer: v, text: "hello" }) }) },
	{ slot: "POST /v1/messages text", send: (v, peer) => ({ method: "POST", path: "/v1/messages", body: asJson({ peer, text: v }) }) },
	{ slot: "POST /v1/messages subject", send: (v, peer) => ({ method: "POST", path: "/v1/messages", body: asJson({ peer, text: "hello", subject: v }) }) },
	{ slot: "POST /v1/messages contextId", send: (v, peer) => ({ method: "POST", path: "/v1/messages", body: asJson({ peer, text: "hello", contextId: v }) }) },
	{ slot: "GET /v1/agents/:peer", send: (v) => ({ method: "GET", path: `/v1/agents/${here(v)}` }) },
	{ slot: "GET /v1/agents/:peer ?capability", send: (v, peer) => ({ method: "GET", path: `/v1/agents/${peer}?verifyNip05=false&capability=${here(v)}` }) },
	{ slot: "POST /v1/subscriptions url", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: v, events: ["message"], acceptAll: true }) }) },
	{ slot: "POST /v1/subscriptions label", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: "http://127.0.0.1:9/hook", label: v, events: ["message"], acceptAll: true }) }) },
	{ slot: "POST /v1/subscriptions capabilities", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: "http://127.0.0.1:9/hook", events: ["task"], capabilities: [v], acceptAll: true }) }) },
	{ slot: "POST /v1/subscriptions allowedPeers", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: "http://127.0.0.1:9/hook", events: ["message"], allowedPeers: [v] }) }) },
	{ slot: "POST /v1/subscriptions events", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: "http://127.0.0.1:9/hook", events: [v], acceptAll: true }) }), unproven: "an event name that does not exist is refused with a fixed message" },
	{ slot: "GET /v1/subscriptions/:id", send: (v) => ({ method: "GET", path: `/v1/subscriptions/${here(v)}` }) },
	{ slot: "DELETE /v1/subscriptions/:id", send: (v) => ({ method: "DELETE", path: `/v1/subscriptions/${here(v)}` }) },
	{ slot: "<unknown path> under /v1", send: (v) => ({ method: "GET", path: `/v1/${here(v)}` }) },
	{ slot: "<unknown path>", send: (v) => ({ method: "GET", path: `/${here(v)}` }) },
	{ slot: "Authorization", send: (v) => ({ method: "GET", path: "/v1/identity", headers: { authorization: `Bearer ${v}` } }), unproven: "a gateway key that is not known gets the same refusal as any other" },
];

/** What one HTTP probe is watched against: where to send it, what the gateway logged, and the files before it. */
interface HttpWatch {
	url: string;
	key: string;
	home: string;
	lines: string[];
	skip: ReadonlySet<string>;
	tree: TreeListing;
}

/**
 * The files once the gateway has finished what the request caused. It writes some state, and sends
 * some events, after it has answered (sometimes 100 ms later), and it saves its own bookkeeping all
 * the time; so it is looked at again until the number of places that hold the key (and the relay
 * events and log lines) has not changed for 250 ms, or three seconds have passed. What it did then
 * belongs to this request and not to the next.
 */
async function settle(watch: HttpWatch, needles: readonly string[]): Promise<TreeListing> {
	const look = () => {
		const tree = readTree(watch.home, watch.skip);
		const shape = [countKey(tree.contents, needles), countKey(tree.names, needles), world.relayLog.filter((entry) => entry.startsWith("EVENT")).length, watch.lines.length].join(",");
		return { tree, shape };
	};
	let last = look();
	let quiet = 0;
	for (let attempt = 0; attempt < 60 && quiet < 5; attempt++) {
		await pause(50);
		const next = look();
		quiet = next.shape === last.shape ? quiet + 1 : 0;
		last = next;
	}
	return last.tree;
}

/** Send one probe and say in which channels `value` came back; the watch moves on to the state after it. */

async function sendProbe(watch: HttpWatch, probe: HttpProbe, value: Planted): Promise<{ channels: Set<Channel>; error: string | null }> {
	const linesBefore = watch.lines.length;
	const relayBefore = world.relayLog.length;
	const attemptsBefore = world.attempts.length;
	const request = probe.send(value.value, world.peerNpub);
	let response = "";
	let error: string | null = null;
	try {
		response = await withDeadline(
			fetch(`${watch.url}${request.path}`, {
				method: request.method,
				headers: { authorization: `Bearer ${watch.key}`, "content-type": "application/json", ...request.headers },
				body: request.body,
			}).then(async (res) => `${res.status}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${await res.text()}`),
			30_000,
			[request.method, request.path],
		);
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}
	const after = await settle(watch, value.needles);
	const before = watch.tree;
	const changed = changedSince(before, after);
	watch.tree = after;
	const texts: Partial<Record<Channel, string>> = {
		response,
		log: watch.lines.slice(linesBefore).join("\n"),
		relay: world.relayLog.slice(relayBefore).join("\n"),
		"file-name": changed.names,
		// The profile's own key is in every request and in the files it makes: only a file that holds it more often than before is a leak of this request.
		"file-content": countKey(after.contents, value.needles) > countKey(before.contents, value.needles) ? changed.contents : "",
		connect: world.attempts.slice(attemptsBefore).map((a) => `${a.host}:${a.port}`).join("\n"),
	};
	const channels = new Set<Channel>();
	for (const [channel, text] of Object.entries(texts) as Array<[Channel, string]>) {
		if (holdsKey(text, value.needles)) {
			channels.add(channel);
		}
	}
	return { channels, error };
}

/** A gateway in a throwaway home, as the profile whose own key is `fixed`, and what is needed to watch it. */
async function startWatchedGateway(fixed: Planted, skip: ReadonlySet<string>): Promise<{ gateway: Awaited<ReturnType<typeof startGateway>>; watch: HttpWatch; restore: () => void }> {
	const box = sandbox();
	try {
		saveIdentity("default", fixed.identity);
		updateProfile("default", { relays: [world.relayUrl] });
		const lines: string[] = [];
		const key = createGatewayKey("default", "canary").key;
		const gateway = await startKeepingConnections(() => startGateway({ profile: "default", port: 0, pollIntervalMs: 200, log: (line) => lines.push(line) }));
		return { gateway, watch: { url: gateway.url, key, home: box.home, lines, skip, tree: readTree(box.home, skip) }, restore: box.restore };
	} catch (error) {
		box.restore();
		throw error;
	}
}

/** Was each gateway field used? A marker sent in it is looked for in everything the gateway shows. */
async function runGatewayReach(result: MatrixResult): Promise<void> {
	const leaking = new Set(result.leaks.filter((leak) => leak.command === GATEWAY_API).map((leak) => leak.slot));
	const clean = HTTP_PROBES.filter((probe) => !leaking.has(probe.slot));
	const started = clean.length > 0 ? await startWatchedGateway(plant("nsec", "http|marker"), new Set()) : null;
	try {
		for (const probe of HTTP_PROBES) {
			let reached = leaking.has(probe.slot);
			if (!reached && started) {
				const sent = await sendProbe(started.watch, probe, { ...plant("nsec", `http|${probe.slot}|marker`), value: MARKER, needles: [MARKER] });
				result.runs += 1;
				reached = sent.channels.size > 0;
			}
			result.reach.push({ command: GATEWAY_API, slot: probe.slot, reached, reason: probe.unproven ?? null });
		}
	} finally {
		await started?.gateway.close().catch(() => undefined);
		started?.restore();
	}
}

async function runGatewayMatrix(result: MatrixResult): Promise<void> {
	for (const form of FORMS) {
		const fixed = plant(form, "http");
		const hexForm = form === "hex" || form === "HEX";
		const skip: ReadonlySet<string> = hexForm ? new Set(["profiles/default/identity.json"]) : new Set();
		const planted = new Map<string, Planted>();
		const found = new Map<string, Set<Channel>>();
		const note = (slot: string, channel: Channel): void => {
			const channels = found.get(slot) ?? new Set<Channel>();
			channels.add(channel);
			found.set(slot, channels);
		};
		let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
		let restore = (): void => undefined;
		try {
			const started = await startWatchedGateway(fixed, skip);
			gateway = started.gateway;
			restore = started.restore;
			const watch = started.watch;
			const box = { home: watch.home };
			for (const probe of HTTP_PROBES) {
				// A new key for every request, so a file that holds it can be traced to the request; the profile's own key is one value.
				const value = hexForm ? fixed : plant(form, `http|${probe.slot}`);
				planted.set(probe.slot, value);
				const sent = await sendProbe(watch, probe, value);
				if (sent.error) {
					result.threw.push(`${GATEWAY_API} | ${probe.slot} | ${form}: ${sent.error}`);
				}
				for (const channel of sent.channels) {
					note(probe.slot, channel);
				}
				result.runs += 1;
			}
			await gateway.close();
			gateway = null;
			// What an earlier request left that only shows once the gateway has saved its state.
			const last = readTree(box.home, skip);
			const owners: Array<[string, Planted]> = hexForm ? [[AFTER_STOP, fixed]] : [...planted.entries()];
			for (const [slot, value] of owners) {
				if (holdsKey(last.names, value.needles)) {
					note(slot, "file-name");
				}
				if (holdsKey(last.contents, value.needles)) {
					note(slot, "file-content");
				}
			}
		} finally {
			await gateway?.close().catch(() => undefined);
			restore();
		}
		for (const [slot, channels] of found) {
			for (const channel of channels) {
				result.leaks.push({ command: GATEWAY_API, slot, form, channel });
			}
		}
		result.probes += HTTP_PROBES.length;
	}
}

/** One run of a plan with `planted` in its slot (or the plain value of `valueOf`, for the run that is not about a key). */
function runPlan(plan: Plan, planted: Planted, json: boolean, valueOf: (home: string) => string = () => planted.value): Promise<Observed> {
	return runOnce((home) => lineFor(plan, valueOf(home), home, json), planted, json, {
		listens: SLOT_TABLE[plan.command]?.listens === true,
		waits: plan.target.type === "slot" && plan.target.spec.waits === true,
		keeps: plan.command === "config set" && plan.target.type === "slot" && plan.target.vary?.["<key>"] === "apiKey",
		opted: SLOT_TABLE[plan.command]?.opted,
	});
}

/** A harmless word to put where a key would go: whatever repeats it shows that the slot was used. */
const MARKER = "canarymark0001";

function reachMarker(plan: Plan): Planted {
	return { ...plant("nsec", `${plan.command}|${plan.slot}|marker`), value: MARKER, needles: [MARKER] };
}

/** What an ordinary, valid value of the plan's slot looks like. */
function ordinaryValue(plan: Plan): (home: string) => string {
	return (home) => (plan.target.type === "slot" ? fillOf(plan.target.slot, plan.target.spec, home) : "default");
}

/**
 * Did the command use the value it was given? Yes if the marker came back anywhere. If not, yes
 * if the command does something else with the marker than with an ordinary value, and does the
 * same every time with the ordinary one (so a difference is the marker's).
 */
async function reached(plan: Plan, result: MatrixResult): Promise<boolean> {
	const marked = await runPlan(plan, reachMarker(plan), false);
	result.runs += 1;
	if (marked.abandoned) {
		result.abandoned.add(`${plan.command} | ${plan.slot}`);
	}
	if (marked.threw) {
		result.threw.push(`${plan.command} | ${plan.slot} | marker: ${marked.threw}`);
	}
	if (marked.channels.size > 0) {
		return true;
	}
	const plain = { ...reachMarker(plan), needles: [] };
	const first = await runPlan(plan, plain, false, ordinaryValue(plan));
	const second = await runPlan(plan, plain, false, ordinaryValue(plan));
	result.runs += 2;
	return first.summary === second.summary && first.summary !== marked.summary;
}

/** One verdict is asked for per slot of a command in scope, per `--profile` and per HTTP probe, with the reason the table gives for it. */
function reachExpected(plans: readonly Plan[], probes: readonly HttpProbe[], gatewayInScope: boolean): Map<string, string | null> {
	const expected = new Map<string, string | null>();
	for (const plan of plans) {
		if (plan.target.type === "slot") {
			expected.set(`${plan.command} | ${plan.slot}`, plan.target.spec.unproven ?? null);
		} else if (plan.target.type === "profile") {
			expected.set(`${plan.command} | ${plan.slot}`, SLOT_TABLE[plan.command]?.profileUnproven ?? null);
		}
	}
	if (gatewayInScope) {
		for (const probe of probes) {
			expected.set(`${GATEWAY_API} | ${probe.slot}`, probe.unproven ?? null);
		}
	}
	return expected;
}

/** Every `unproven` and `profileUnproven` text the table holds for a command in scope, and for the HTTP probes. */
function reachTexts(probes: readonly HttpProbe[], gatewayInScope: boolean): Map<string, string[]> {
	const texts = new Map<string, string[]>();
	const add = (command: string, text: string | undefined): void => {
		if (text !== undefined) {
			texts.set(command, [...(texts.get(command) ?? []), text]);
		}
	};
	for (const [command, entry] of Object.entries(SLOT_TABLE)) {
		if (!inScopeName(command)) {
			continue;
		}
		add(command, entry.profileUnproven);
		for (const raw of Object.values(entry.slots)) {
			add(command, specOf(raw).unproven);
		}
	}
	if (gatewayInScope) {
		for (const probe of probes) {
			add(GATEWAY_API, probe.unproven);
		}
	}
	return texts;
}

/**
 * What is wrong with the reach verdicts: a slot that has none (so its clean result proves nothing), one that has
 * two, a verdict for something that is not probed, a reason that is not the table's, and a text of the table that
 * no verdict carries.
 */
function reachProblems(expected: ReadonlyMap<string, string | null>, texts: ReadonlyMap<string, readonly string[]>, reach: MatrixResult["reach"]): string[] {
	const problems: string[] = [];
	const seen = new Map<string, number>();
	for (const slot of reach) {
		const named = `${slot.command} | ${slot.slot}`;
		seen.set(named, (seen.get(named) ?? 0) + 1);
		if (!expected.has(named)) {
			problems.push(`a verdict for a slot that is not probed: ${named}`);
		} else if (expected.get(named) !== slot.reason) {
			problems.push(`the reason of ${named} is not the one in SLOT_TABLE`);
		}
		if (slot.reason === "") {
			problems.push(`\`unproven\` has no reason: ${named}`);
		} else if (!slot.reached && slot.reason === null) {
			problems.push(`never reached, so its clean result means nothing: ${named} (give the command what it needs in SLOT_TABLE, or say why it cannot be reached with \`unproven\`)`);
		} else if (slot.reached && slot.reason !== null) {
			problems.push(`reached after all, remove \`unproven\`: ${named} (${slot.reason})`);
		}
	}
	for (const named of expected.keys()) {
		const count = seen.get(named) ?? 0;
		if (count === 0) {
			problems.push(`no verdict on whether the command used it: ${named}`);
		} else if (count > 1) {
			problems.push(`${count} verdicts for one slot: ${named}`);
		}
	}
	for (const [command, list] of texts) {
		const carried = new Set(reach.filter((slot) => slot.command === command).map((slot) => slot.reason));
		for (const text of list) {
			if (!carried.has(text)) {
				problems.push(`a reason in SLOT_TABLE that no verdict of "${command}" carries: ${text.slice(0, 60)}`);
			}
		}
	}
	return problems;
}

let matrix: Promise<MatrixResult> | null = null;

function runMatrix(): Promise<MatrixResult> {
	matrix ??= (async () => {
		const started = performance.now();
		const nodes = walkProgram(buildProgram());
		const plans = plansFor(nodes).filter((plan) => inScopeName(plan.command));
		const result: MatrixResult = {
			leaks: [],
			probes: 0,
			runs: 0,
			millis: 0,
			threw: [],
			forbidden: [],
			slow: [],
			slots: 0,
			commands: nodes.length,
			abandoned: new Set(),
			reach: [],
		};
		const slotKeys = new Set<string>();
		for (const plan of plans) {
			slotKeys.add(`${plan.command}|${plan.slot}`);
			for (const form of FORMS) {
				const planted = plant(form, `${plan.command}|${plan.slot}`);
				result.probes += 1;
				const found = new Map<Channel, true>();
				for (const json of [false, true]) {
					const observed = await runPlan(plan, planted, json);
					result.runs += 1;
					if (observed.abandoned) {
						result.abandoned.add(`${plan.command} | ${plan.slot}`);
					}
					if (observed.threw) {
						result.threw.push(`${plan.command} | ${plan.slot} | ${form}: ${observed.threw}`);
					}
					for (const attempt of observed.forbidden) {
						result.forbidden.push(`${plan.command} | ${plan.slot} | ${form}: ${attempt.host}:${attempt.port}`);
					}
					if (observed.millis > 2000) {
						result.slow.push({ line: `${plan.command} | ${plan.slot} | ${form}`, millis: Math.round(observed.millis) });
					}
					for (const channel of observed.channels) {
						found.set(channel, true);
					}
				}
				for (const channel of found.keys()) {
					result.leaks.push({ command: plan.command, slot: plan.slot, form, channel });
				}
			}
		}
		// A slot that repeats nothing is only clean if the command used what it was given. A marker shows that.
		const leaking = new Set(result.leaks.map((leak) => `${leak.command} | ${leak.slot}`));
		for (const plan of plans) {
			if (plan.target.type !== "slot" && plan.target.type !== "profile") {
				continue;
			}
			const used = leaking.has(`${plan.command} | ${plan.slot}`) || (await reached(plan, result));
			const reason = plan.target.type === "slot" ? (plan.target.spec.unproven ?? null) : (SLOT_TABLE[plan.command]?.profileUnproven ?? null);
			result.reach.push({ command: plan.command, slot: plan.slot, reached: used, reason });
		}
		if (inScopeName(GATEWAY_API)) {
			await runGatewayMatrix(result);
			await runGatewayReach(result);
			for (const probe of HTTP_PROBES) {
				slotKeys.add(`${GATEWAY_API}|${probe.slot}`);
			}
		}
		result.slots = slotKeys.size;
		result.millis = performance.now() - started;
		return result;
	})();
	return matrix;
}

/**
 * Starts a server that never closes an idle connection by itself. Node closes one
 * after 5 seconds; a client that reuses it just then gets a reset, and a run that
 * pauses between two requests to the mock would fail by chance.
 */
async function startKeepingConnections<T>(start: () => Promise<T>): Promise<T> {
	const inherited = HttpServer.prototype.listen as (this: HttpServer, ...args: unknown[]) => HttpServer;
	const own = HttpServer.prototype as unknown as { listen?: unknown };
	own.listen = function (this: HttpServer, ...args: unknown[]): HttpServer {
		this.keepAliveTimeout = 0;
		return inherited.apply(this, args);
	};
	try {
		return await start();
	} finally {
		delete own.listen;
	}
}

beforeAll(async () => {
	startedIn = process.cwd();
	const guard = guardConnections();
	restoreGuard = guard.restore;
	// Node 20 has no global WebSocket, and `agx card` reaches its relays through it without bringing one. Without this, on Node 20
	// that command never connects and the canary would see less than on Node 22 and later, where the list was made.
	if (typeof globalThis.WebSocket === "undefined") {
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		restoreWebSocket = () => {
			delete (globalThis as { WebSocket?: unknown }).WebSocket;
		};
	}
	// A profile that has opted in to Tailscale would start a node. No command may: the package is reported missing.
	restoreTailscale = setTailscaleSdkLoaderForTests(() => Promise.reject(new Error("no Tailscale package in the canary")));
	const relayLog: string[] = [];
	const relay = await startKeepingConnections(() =>
		startRelay({
			port: 0,
			onEvent: (event) => relayLog.push(`EVENT ${JSON.stringify(event)}`),
			onRequest: (filters) => relayLog.push(`REQ ${JSON.stringify(filters)}`),
		}),
	);
	expect(FORBIDDEN_PORTS.has(relay.port)).toBe(false);
	const index = await startKeepingConnections(() => startMockIndexServer());
	index.setRpc("agentIndex/searchListings", () => ({ output: { listings: [], total: 0 } }));
	index.setRpc("agentIndex/listDomains", () => ({ output: { domains: [] } }));
	// `domain add` prints the file to serve only after the claim succeeds, and `--handle` is in that file: let it get that far.
	index.setRpc("agentIndex/createDomain", () => ({ output: { id: "dom-1", domain: "example.com", status: "pending" } }));
	index.setRpc("exchange/listPeers", () => ({ output: { peers: [] } }));
	// `register` asks for a challenge and proves the key before it creates the listing: let it get as far as that.
	index.setRpc("agentIndex/createKeyChallenge", () => ({ output: { nonce: "n".repeat(32), expiresAt: "2099-01-01T00:00:00Z", pubkey: "x" } }));
	index.setRpc("agentIndex/submitKeyProof", () => ({ output: { ok: true } }));
	world = {
		index,
		indexKey: index.addKey().key,
		relay,
		relayUrl: `ws://127.0.0.1:${relay.port}`,
		relayLog,
		peerNpub: plant("nsec", "peer").identity.npub,
		attempts: guard.attempts,
	};
}, 30_000);

afterAll(async () => {
	restoreWebSocket();
	restoreTailscale?.();
	restoreGuard?.();
	await world?.relay.close();
	await world?.index.close();
	removeMade();
});

// ============================================================= the known leaks

type Channels = readonly Channel[];

/**
 * One line of what leaks today: one command, one slot, and the key forms and
 * channels in which it leaks there. Every combination a line spells out is
 * expected to leak, and nothing else. The test fails for a leak that no line
 * covers, and for a listed combination that no longer leaks. The lines are in
 * order (command, then slot), so a fix deletes its own lines and nothing around
 * them changes.
 */
interface KnownLeak {
	/** The command as typed after `agx`, or the gateway's HTTP API. */
	command: string;
	slot: string;
	forms: readonly Form[] | typeof ALL;
	channels: Channels;
	/** The open pull request that fixes it, or why it is not fixed. Never empty. */
	reason: string;
}

const ALL = "*" as const;
/** The forms that look like a key: a check for `nsec1` sees them. */
const SHAPED: readonly Form[] = ["nsec", "ncryptsec", "nostr", "sentence", "NSEC"];
/** The profile's own key, as 64 hex characters: a check for `nsec1` does not see it. */
const OWN: readonly Form[] = ["hex", "HEX"];

/** Why a line is listed. REASON_RULES, below, says where each reason may stand. */
const WHY = {
	pr61: "open PR #61 hides a run of 56 or more hex digits, in any case, in an unknown command or option",
	tooMany: "the parser's 'too many arguments' quotes every extra word; open PR #61 leaves it on purpose except for `gateway`",
	pr64_66: "open PRs #64 and #66 refuse a profile name that holds nsec1, in any case",
	profileName: "a hex or %xx-escaped profile name is a valid folder name; no rule yet says what a profile name may hold",
	pr65: "open PR #65 refuses a value that holds nsec1, in any case",
	pr75: "open PR #75 refuses and hides a value that holds a key, also %xx-escaped",
	messageText: "open decision: should message text and subjects stop for a key (the UI asks first)?",
	afterStop: "a task keeps its agent as typed in the task file; the profile's own key as hex is a valid public key",
	sendDecision: "open decision: should `agx send` refuse a key in the message, subject or context id?",
	ownHex: "the profile's own key as 64 hex characters has no nsec1 shape; only matching its exact value, or knowing what the slot may hold, can tell (once the profile has been read, the exact value is removed from everything the CLI prints and from every gateway answer, and from no other channel)",
	escaped: "a key written as %xx escapes is not stopped at this slot: the shared check in @nostr-agx/nostr reads %xx, but nothing here calls it yet",
	unchecked: "no open PR covers this slot yet",
} as const;

const PARSER_SLOT = /^<unknown (command|option|subcommand)>$/;
const PROFILE_SLOT = /^(--profile|<profile>)$/;
const ELSEWHERE = ["hex", "HEX", "escaped"] as const;

/**
 * Where a reason may stand: the commands, the slots and the key forms its text speaks of (for a pull request, what
 * its diff changes). A line whose reason does not fit its command, slot or forms fails the test of the lists, so a
 * reason cannot be copied onto a line it says nothing about. Reasons that are open decisions say nothing checkable.
 */
const REASON_RULES: ReadonlyArray<{ reason: string; command?: RegExp; slot?: RegExp; forms?: readonly Form[] }> = [
	{ reason: WHY.pr61, slot: PARSER_SLOT, forms: OWN },
	{ reason: WHY.tooMany, slot: /^<extra argument>$/, forms: OWN },
	{ reason: WHY.pr64_66, slot: PROFILE_SLOT, forms: SHAPED },
	{ reason: WHY.profileName, slot: PROFILE_SLOT, forms: ELSEWHERE },
	{ reason: WHY.pr65, command: /^(search|peers (accept|refuse|ignore|block)|listing (get|publish|set-visibility|delist|delete|set-policy))$/, slot: /^(\[query\]|\[listingId\]|--peer)$/, forms: SHAPED },
	{ reason: WHY.pr75, command: /^gateway \(HTTP API\)$/ },
	{ reason: WHY.ownHex, forms: OWN },
	{ reason: WHY.escaped, forms: ["escaped"] },
	{ reason: WHY.unchecked, forms: SHAPED },
];

/** Slots whose job is to take a secret and keep it: the value is expected in a file or a request. */
const INTENDED: readonly KnownLeak[] = [
	{ command: "config set", slot: "--stdin (stdin) (key=apiKey)", forms: ["nsec", "ncryptsec", "hex", "HEX", "nostr", "escaped", "NSEC"], channels: ["file-content", "request"], reason: "config set apiKey keeps the API key and sends it to the index as the bearer" },
	{ command: "config set", slot: "[value] (key=apiKey)", forms: ["nsec", "ncryptsec", "hex", "HEX", "nostr", "escaped", "NSEC"], channels: ["file-content", "request"], reason: "config set apiKey keeps the API key and sends it to the index as the bearer" },
	{ command: "identity import", slot: "--stdin (stdin)", forms: ["nsec", "nostr", "NSEC"], channels: ["file-content"], reason: "identity import keeps the key it is given, in identity.json" },
	{ command: "identity import", slot: "[secret]", forms: ["nsec", "nostr", "NSEC"], channels: ["file-content"], reason: "identity import keeps the key it is given, in identity.json" },
	{ command: "tailscale enable", slot: "--auth-key", forms: ALL, channels: ["file-content"], reason: "a Tailscale secret is kept in tailscale.json" },
	{ command: "tailscale enable", slot: "--auth-key-stdin (stdin)", forms: ALL, channels: ["file-content"], reason: "a Tailscale secret is kept in tailscale.json" },
	{ command: "tailscale enable", slot: "--oauth-client-secret", forms: ALL, channels: ["file-content"], reason: "a Tailscale secret is kept in tailscale.json" },
	{ command: "tailscale enable", slot: "--oauth-client-secret-stdin (stdin)", forms: ALL, channels: ["file-content"], reason: "a Tailscale secret is kept in tailscale.json" },
];

/** What `main` still repeats, writes or sends. Each fix deletes its lines. */
const KNOWN_LEAKS: readonly KnownLeak[] = [
	{ command: "config set", slot: "--stdin (stdin) (key=apiBaseUrl)", forms: OWN, channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ command: "config set", slot: "--stdin (stdin) (key=nip05)", forms: OWN, channels: ["file-content"], reason: WHY.ownHex },
	{ command: "config set", slot: "--stdin (stdin) (key=nip05)", forms: ["escaped"], channels: ["file-content"], reason: WHY.escaped },
	{ command: "config set", slot: "--stdin (stdin) (key=nip05)", forms: SHAPED, channels: ["file-content"], reason: WHY.unchecked },
	{ command: "config set", slot: "--stdin (stdin) (key=org)", forms: OWN, channels: ["file-content"], reason: WHY.ownHex },
	{ command: "config set", slot: "--stdin (stdin) (key=org)", forms: ["escaped"], channels: ["file-content"], reason: WHY.escaped },
	{ command: "config set", slot: "--stdin (stdin) (key=org)", forms: SHAPED, channels: ["file-content"], reason: WHY.unchecked },
	{ command: "config set", slot: "--stdin (stdin) (key=orgSlug)", forms: OWN, channels: ["file-content"], reason: WHY.ownHex },
	{ command: "config set", slot: "--stdin (stdin) (key=orgSlug)", forms: ["escaped"], channels: ["file-content"], reason: WHY.escaped },
	{ command: "config set", slot: "--stdin (stdin) (key=orgSlug)", forms: SHAPED, channels: ["file-content"], reason: WHY.unchecked },
	{ command: "config set", slot: "--stdin (stdin) (key=relays)", forms: OWN, channels: ["file-content"], reason: WHY.ownHex },
	{ command: "config set", slot: "--stdin (stdin) (key=relays)", forms: ["escaped"], channels: ["file-content"], reason: WHY.escaped },
	{ command: "config set", slot: "--stdin (stdin) (key=relays)", forms: SHAPED, channels: ["file-content"], reason: WHY.unchecked },
	{ command: "gateway (HTTP API)", slot: "<saved when the gateway stops>", forms: OWN, channels: ["file-content"], reason: WHY.afterStop },
	{ command: "gateway (HTTP API)", slot: "GET /v1/agents/:peer", forms: OWN, channels: ["relay"], reason: WHY.ownHex },
	{ command: "gateway (HTTP API)", slot: "POST /v1/messages contextId", forms: ["nsec", "ncryptsec", "nostr", "NSEC"], channels: ["file-content"], reason: WHY.pr75 },
	{ command: "gateway (HTTP API)", slot: "POST /v1/messages contextId", forms: OWN, channels: ["file-content"], reason: WHY.ownHex },
	{ command: "gateway (HTTP API)", slot: "POST /v1/messages peer", forms: OWN, channels: ["file-content", "relay"], reason: WHY.ownHex },
	{ command: "gateway (HTTP API)", slot: "POST /v1/messages subject", forms: ALL, channels: ["file-content"], reason: WHY.messageText },
	{ command: "gateway (HTTP API)", slot: "POST /v1/messages text", forms: ALL, channels: ["file-content"], reason: WHY.messageText },
	{ command: "gateway (HTTP API)", slot: "POST /v1/subscriptions allowedPeers", forms: OWN, channels: ["file-content"], reason: WHY.ownHex },
	{ command: "gateway (HTTP API)", slot: "POST /v1/subscriptions capabilities", forms: ["nsec", "ncryptsec", "nostr", "escaped", "sentence", "NSEC"], channels: ["file-content"], reason: WHY.pr75 },
	{ command: "gateway (HTTP API)", slot: "POST /v1/subscriptions capabilities", forms: OWN, channels: ["file-content"], reason: WHY.ownHex },
	{ command: "gateway (HTTP API)", slot: "POST /v1/subscriptions label", forms: ["nsec", "ncryptsec", "nostr", "escaped", "sentence", "NSEC"], channels: ["file-content"], reason: WHY.pr75 },
	{ command: "gateway (HTTP API)", slot: "POST /v1/subscriptions label", forms: OWN, channels: ["file-content"], reason: WHY.ownHex },
	{ command: "gateway (HTTP API)", slot: "POST /v1/tasks peer", forms: OWN, channels: ["relay"], reason: WHY.ownHex },
	{ command: "request", slot: "--payload", forms: OWN, channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ command: "send", slot: "--subject", forms: ALL, channels: ["file-content"], reason: WHY.sendDecision },
	{ command: "send", slot: "<message>", forms: ALL, channels: ["file-content"], reason: WHY.sendDecision },
];

function tupleOf(command: string, slot: string, form: string, channel: string): string {
	return `${command} | ${slot} | ${form} | ${channel}`;
}

interface Universe {
	/** `command | slot` for every slot the canary probes. */
	slots: Set<string>;
}

function universeOf(nodes: CommandNode[]): Universe {
	const slots = new Set<string>();
	for (const plan of plansFor(nodes)) {
		slots.add(`${plan.command} | ${plan.slot}`);
	}
	for (const probe of HTTP_PROBES) {
		slots.add(`${GATEWAY_API} | ${probe.slot}`);
	}
	// Not a request: what the gateway leaves in its files once it has stopped.
	slots.add(`${GATEWAY_API} | ${AFTER_STOP}`);
	return { slots };
}

/** Every combination the lines spell out, with the reason it is listed; and what is wrong with the lines themselves. */
function expand(entries: readonly KnownLeak[], universe: Universe): { tuples: Map<string, string>; problems: string[] } {
	const tuples = new Map<string, string>();
	const problems: string[] = [];
	let before: KnownLeak | null = null;
	for (const entry of entries) {
		const where = `${entry.command} | ${entry.slot}`;
		if (before && (before.command > entry.command || (before.command === entry.command && before.slot > entry.slot))) {
			problems.push(`out of order: "${where}" comes before "${before.command} | ${before.slot}"`);
		}
		before = entry;
		if (entry.reason.trim() === "") {
			problems.push(`no reason given for ${where}: say why it is listed`);
		}
		const rule = REASON_RULES.find((candidate) => candidate.reason === entry.reason);
		if (rule) {
			const forms = entry.forms === ALL ? FORMS : entry.forms;
			if (rule.command && !rule.command.test(entry.command)) {
				problems.push(`the reason of ${where} is for commands like ${rule.command}: "${entry.reason}"`);
			}
			if (rule.slot && !rule.slot.test(entry.slot)) {
				problems.push(`the reason of ${where} is for slots like ${rule.slot}: "${entry.reason}"`);
			}
			const wrong = rule.forms ? forms.filter((form) => !rule.forms?.includes(form)) : [];
			if (wrong.length > 0) {
				problems.push(`the reason of ${where} does not cover the forms ${wrong.join(", ")}: "${entry.reason}"`);
			}
		}
		if (!universe.slots.has(where)) {
			problems.push(`"${entry.command}" has no slot "${entry.slot}" that is probed`);
			continue;
		}
		const forms = entry.forms === ALL ? FORMS : entry.forms;
		for (const form of forms) {
			for (const channel of entry.channels) {
				const tuple = tupleOf(entry.command, entry.slot, form, channel);
				if (tuples.has(tuple)) {
					problems.push(`listed twice: ${tuple}`);
				}
				tuples.set(tuple, entry.reason);
			}
		}
	}
	return { tuples, problems };
}

/** Slots that are not of class `secret` and still take one: `config set` is given an API key as a value, and keeps it. */
const SECRET_BY_VALUE: ReadonlySet<string> = new Set(["config set | [value] (key=apiKey)"]);

/** INTENDED is for a slot whose job is to take a secret and keep it: its class in the slot table is `secret`, or it is listed above. */
function intendedProblems(entries: readonly KnownLeak[], nodes: CommandNode[]): string[] {
	const classes = new Map<string, string>();
	for (const plan of plansFor(nodes)) {
		classes.set(`${plan.command} | ${plan.slot}`, plan.target.type === "slot" ? plan.target.spec.kind : plan.target.type);
	}
	const problems: string[] = [];
	for (const entry of entries) {
		const where = `${entry.command} | ${entry.slot}`;
		const kind = classes.get(where);
		if (kind !== undefined && kind !== "secret" && !SECRET_BY_VALUE.has(where)) {
			problems.push(`${where} is in INTENDED but its class in SLOT_TABLE is "${kind}", not "secret": a leak there belongs in KNOWN_LEAKS`);
		}
	}
	return problems;
}

/** `CANARY_ONLY=search,listing list` runs only the commands whose name starts with one of those texts. */
function inScopeName(text: string): boolean {
	const only = process.env.CANARY_ONLY;
	return !only || only.split(",").some((prefix) => text.startsWith(prefix.trim()));
}

/** What is listed, for the commands that are run (all of them unless `CANARY_ONLY` is set). */
function inScope(tuples: Map<string, string>): Map<string, string> {
	return new Map([...tuples].filter(([tuple]) => inScopeName(tuple)));
}

/**
 * One line per slot and reason, sorted: what is wrong there, by channel and in each the forms. The
 * lines of a slot are the lines of one entry, so a fix finds its own at once.
 */
function perSlot(tuples: Iterable<readonly [string, string | null]>, text: (slot: string, where: string, reason: string | null) => string): string[] {
	const groups = new Map<string, { slot: string; reason: string | null; channels: Map<string, string[]> }>();
	for (const [tuple, reason] of [...tuples].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const parts = tuple.split(" | ");
		const channel = parts.pop() as string;
		const form = parts.pop() as string;
		const slot = parts.join(" | ");
		const group = groups.get(`${slot}\u0000${reason}`) ?? { slot, reason, channels: new Map<string, string[]>() };
		group.channels.set(channel, [...(group.channels.get(channel) ?? []), form]);
		groups.set(`${slot}\u0000${reason}`, group);
	}
	return [...groups.values()].map((group) => text(group.slot, [...group.channels].sort(([a], [b]) => (a < b ? -1 : 1)).map(([channel, forms]) => `${channel}: ${forms.sort().join(", ")}`).join("; "), group.reason));
}

/** What the run found against what is listed; every line says what to do. */
function compare(found: ReadonlySet<string>, known: Map<string, string>, intended: Map<string, string>): string[] {
	const fresh = [...found].filter((tuple) => !known.has(tuple) && !intended.has(tuple)).map((tuple) => [tuple, null] as const);
	const both = [...known.keys()].filter((tuple) => intended.has(tuple)).map((tuple) => [tuple, null] as const);
	const gone = [...known].filter(([tuple]) => !found.has(tuple));
	const notIntended = [...intended].filter(([tuple]) => !found.has(tuple));
	return [
		...perSlot(fresh, (slot, where) => `new leak, not in KNOWN_LEAKS: ${slot} (${where})`),
		...perSlot(both, (slot, where) => `in both KNOWN_LEAKS and INTENDED: ${slot} (${where})`),
		...perSlot(gone, (slot, where, reason) => `no longer leaks, remove it from KNOWN_LEAKS: ${slot} (${where}); listed because: ${reason}`),
		...perSlot(notIntended, (slot, where, reason) => `no longer stored or sent, remove it from INTENDED: ${slot} (${where}); listed because: ${reason}`),
	];
}

// ================================================================== the controls

/** A program that echoes what it is given, on purpose, to every place the canary looks. */
function leakyProgram(): Command {
	const program = new Command("leaky").exitOverride().option("--json");
	program.configureOutput({ outputError: (text, write) => write(text) });
	const add = (name: string, action: (value: string) => void | Promise<void>): void => {
		program.command(`${name} <value>`).action(async (value: string) => {
			await action(value);
		});
	};
	const home = (): string => process.env.AGX_HOME as string;
	add("out", (value) => console.log(`you typed ${value}`));
	add("err", (value) => console.error(`you typed ${value}`));
	// A stretch of 12 characters from the middle: found by a 10-character window, missed by a 20-character one.
	add("part", (value) => console.log(value.slice(Math.floor(value.length / 2) - 6, Math.floor(value.length / 2) + 6)));
	add("request", async (value) => {
		await fetch(`${world.index.origin}/echo`, { method: "POST", body: JSON.stringify({ value }) });
	});
	add("relay", async (value) => {
		const socket = new WebSocket(world.relayUrl);
		await new Promise<void>((resolve, reject) => {
			socket.on("open", () => socket.send(JSON.stringify(["REQ", "control", { "#t": [value] }])));
			socket.on("message", () => resolve());
			socket.on("error", reject);
		});
		socket.close();
	});
	add("file-name", (value) => writeFileSync(join(home(), encodeURIComponent(value).slice(0, 200)), "x"));
	add("file-content", (value) => writeFileSync(join(home(), "note.txt"), `note: ${value}`));
	add("connect", async (value) => {
		await dns.promises.lookup(`${value}.invalid`).catch(() => undefined);
	});
	add("socket", (value) => new Promise<void>((resolve) => {
		const socket = net.connect({ host: `${value}.invalid`, port: 80 });
		socket.on("error", () => resolve());
	}));
	// The key comes after more than a screenful of other text: a capture that keeps only the first part misses it.
	add("long-out", (value) => console.log(`${"x".repeat(500)} ${value}`));
	add("long-err", (value) => console.error(`${"x".repeat(500)} ${value}`));
	add("query", async (value) => {
		await fetch(`${world.index.origin}/echo?note=${value}`);
	});
	add("tmp-name", (value) => writeFileSync(join(tmpdir(), encodeURIComponent(value).slice(0, 200)), "x"));
	add("tmp-content", (value) => writeFileSync(join(tmpdir(), "note.txt"), `note: ${value}`));
	add("remember", (value) => rememberSecret(value));
	add("clean", () => console.log("all good"));
	// A command that never ends, and a server that ignores the signal that should stop it.
	add("hang", () => new Promise<void>(() => undefined));
	add("stubborn", () => {
		process.once("SIGINT", () => undefined);
		return new Promise<void>(() => undefined);
	});
	return program;
}

async function runLeaky(args: string[]): Promise<number> {
	try {
		await leakyProgram().parseAsync(args, { from: "user" });
		return 0;
	} catch (error) {
		if (error instanceof CommanderError) {
			return error.exitCode;
		}
		throw error;
	}
}

/** One run of the leaky program through the same code the canary uses for `agx`. */
function observeLeaky(command: string, planted: Planted, json: boolean, options: Parameters<typeof runOnce>[3] = {}): Promise<Observed> {
	return runOnce((_home) => ({ args: [...(json ? ["--json"] : []), command, planted.value], stdin: null }), planted, json, { ...options, run: runLeaky });
}

// ===================================================================== the tests

const LONG = 900_000;

describe("the secret-key canary", () => {
	it("classifies every command, option and positional of the program", () => {
		expect(unclassified(walkProgram(buildProgram()))).toEqual([]);
	});

	it("lists only slots that exist, each combination once, each with a reason, in order", () => {
		const universe = universeOf(walkProgram(buildProgram()));
		expect(expand(KNOWN_LEAKS, universe).problems).toEqual([]);
		expect(expand(INTENDED, universe).problems).toEqual([]);
	});

	it("keeps INTENDED to the slots that take a secret", () => {
		expect(intendedProblems(INTENDED, walkProgram(buildProgram()))).toEqual([]);
	});

	it("finds no leak that is not listed, and no listed leak that is gone", async () => {
		const result = await runMatrix();
		const universe = universeOf(walkProgram(buildProgram()));
		const known = expand(KNOWN_LEAKS, universe);
		const intended = expand(INTENDED, universe);
		const found = new Set(result.leaks.map((leak) => tupleOf(leak.command, leak.slot, leak.form, leak.channel)));
		expect(compare(found, inScope(known.tuples), inScope(intended.tuples))).toEqual([]);
	}, LONG);

	it("stays on this machine, ends every command and never throws", async () => {
		const result = await runMatrix();
		expect(result.forbidden).toEqual([]);
		expect(result.threw).toEqual([]);
		expect(homesMade.filter((home) => existsSync(home))).toEqual([]);
		expect(process.cwd()).toBe(startedIn);
	}, LONG);

	it("reached every slot that comes out clean, or says why it could not", async () => {
		const result = await runMatrix();
		const plans = plansFor(walkProgram(buildProgram())).filter((plan) => inScopeName(plan.command));
		const gateway = inScopeName(GATEWAY_API);
		expect(reachProblems(reachExpected(plans, HTTP_PROBES, gateway), reachTexts(HTTP_PROBES, gateway), result.reach)).toEqual([]);
	}, LONG);

	it("leaves a command waiting only where the slot table says it waits", async () => {
		const result = await runMatrix();
		const waits = plansFor(walkProgram(buildProgram()))
			.filter((plan) => inScopeName(plan.command) && plan.target.type === "slot" && plan.target.spec.waits === true)
			.map((plan) => `${plan.command} | ${plan.slot}`);
		expect([...result.abandoned].sort()).toEqual([...new Set(waits)].sort());
	}, LONG);

	describe("the controls", () => {
		const planOf = (command: string, slot: string): Plan & { target: Extract<Target, { type: "slot" }> } => {
			const plan = plansFor(walkProgram(buildProgram())).find((candidate) => candidate.command === command && candidate.slot === slot);
			if (!plan || plan.target.type !== "slot") {
				throw new Error(`no slot "${slot}" of "${command}"`);
			}
			return plan as Plan & { target: Extract<Target, { type: "slot" }> };
		};

		it("gets as far as the slot in commands that need other options and arguments first", async () => {
			const cases: Array<[string, string]> = [
				["login", "--org-name"],
				["login", "--org-slug"],
				["listing create", "--display-name"],
				["listing create", "--handle"],
				["register", "--display-name"],
				["register", "--handle"],
				["listing get", "--org"],
				["listing set-policy", "--capability"],
				["tailscale up", "--hostname"],
				["config set", "--stdin (stdin) (key=org)"],
			];
			const missed: string[] = [];
			for (const [command, slot] of cases) {
				const plan = planOf(command, slot);
				const observed = await runPlan(plan, reachMarker(plan), false);
				if (observed.threw || observed.channels.size === 0) {
					missed.push(`${command} | ${slot}: ${observed.threw ?? "the marker did not show up"}`);
				}
			}
			expect(missed).toEqual([]);
		}, LONG);

		it("can tell that a command stopped before it used the slot", async () => {
			const plan = planOf("listing create", "--display-name");
			// Without `--pubkey` the command stops with "Pass exactly one of --team or --pubkey".
			const stopped = { ...plan, target: { ...plan.target, spec: { ...plan.target.spec, without: ["--pubkey"] } } };
			const missing = await runPlan(stopped, reachMarker(stopped), false);
			expect(missing.threw).toBeNull();
			expect([...missing.channels]).toEqual([]);
			const unused = planOf("serve", "--reply-text");
			const never = await runPlan(unused, reachMarker(unused), false);
			expect([...never.channels]).toEqual([]);
		}, LONG);

		// Every place the canary looks, with a command that repeats its argument there on purpose.
		const CONTROLS: Array<{ command: string; forms: readonly Form[]; channel: "stdout" | "stderr" | Channel }> = [
			{ command: "out", forms: FORMS, channel: "stdout" },
			{ command: "err", forms: FORMS, channel: "stderr" },
			{ command: "part", forms: ["nsec", "ncryptsec", "hex", "HEX", "nostr", "NSEC"], channel: "stdout" },
			{ command: "request", forms: FORMS, channel: "request" },
			{ command: "relay", forms: FORMS, channel: "relay" },
			{ command: "file-name", forms: ["nsec", "ncryptsec", "hex", "HEX", "nostr", "NSEC"], channel: "file-name" },
			{ command: "file-content", forms: FORMS, channel: "file-content" },
			{ command: "connect", forms: ["nsec", "ncryptsec", "hex", "HEX", "NSEC"], channel: "connect" },
			{ command: "socket", forms: ["nsec", "ncryptsec", "hex", "HEX", "NSEC"], channel: "connect" },
			{ command: "long-out", forms: FORMS, channel: "stdout" },
			{ command: "long-err", forms: FORMS, channel: "stderr" },
			{ command: "query", forms: FORMS, channel: "request" },
			{ command: "tmp-name", forms: ["nsec", "ncryptsec", "hex", "HEX", "nostr", "NSEC"], channel: "file-name" },
			{ command: "tmp-content", forms: FORMS, channel: "file-content" },
		];
		const here = (channel: Channel, json: boolean): Channel =>
			json && channel === "stdout" ? "json-stdout" : json && channel === "stderr" ? "json-stderr" : channel;

		for (const control of CONTROLS) {
			it(`reports a key that \`${control.command}\` repeats, in every form`, async () => {
				const missed: string[] = [];
				for (const form of control.forms) {
					for (const json of [false, true]) {
						const planted = plant(form, `leaky ${control.command}`);
						const observed = await observeLeaky(control.command, planted, json);
						if (observed.threw || !observed.channels.has(here(control.channel, json))) {
							missed.push(`${control.command} | ${form} | ${json ? "--json" : "human"}: ${observed.threw ?? `not seen in ${here(control.channel, json)}`}`);
						}
					}
				}
				expect(missed).toEqual([]);
			}, LONG);
		}

		it("notices a program that teaches the redactor the key", async () => {
			const observed = await observeLeaky("remember", plant("nsec", "remember"), false);
			expect(observed.threw).toMatch(/remembered the planted key/);
		});

		it("fails a command that never ends, and leaves behind only one that is marked as waiting", async () => {
			const stuck = await observeLeaky("hang", plant("nsec", "hang"), false, { deadline: 300 });
			expect(stuck.threw).toMatch(/did not finish in 300 ms/);
			expect(stuck.abandoned).toBe(false);
			const waiting = await observeLeaky("hang", plant("nsec", "hang"), false, { deadline: 300, waits: true });
			expect(waiting.threw).toBeNull();
			expect(waiting.abandoned).toBe(true);
		});

		it("fails a server that neither ends by itself nor stops on the signal", async () => {
			const none = await observeLeaky("hang", plant("nsec", "hang"), false, { listens: true, deadline: 2000 });
			expect(none.threw).toMatch(/has not stopped on a signal \(it registered no handler\)/);
			const stubborn = await observeLeaky("stubborn", plant("nsec", "stubborn"), false, { listens: true, deadline: 2000 });
			expect(stubborn.threw).toMatch(/has not stopped on a signal$/);
		});

		it("does not start a run whose profile does not point at the throwaway relay", async () => {
			const elsewhere = () => {
				delete process.env.AGX_RELAY;
				updateProfile("default", { relays: ["ws://127.0.0.1:9"] });
			};
			await expect(observeLeaky("clean", plant("nsec", "pin"), false, { afterSetup: elsewhere })).rejects.toThrow(/does not pin the relay for profile "default"/);
		});

		it("notices a command, an option and a positional that the slot table does not list", () => {
			const program = buildProgram();
			program.command("throwaway <value>").option("--extra <text>").action(() => undefined);
			const search = program.commands.find((command) => command.name() === "search") as Command;
			search.option("--new-flag <text>").argument("[more]");
			const problems = unclassified(walkProgram(program));
			expect(problems).toContain('command "throwaway" is not in SLOT_TABLE; its slots: <value> (takes a value), --extra (takes a value)');
			expect(problems).toContain('"search" --new-flag takes a value and has no class in SLOT_TABLE');
			expect(problems).toContain('"search" [more] takes a value and has no class in SLOT_TABLE');
		});

		it("notices a slot table entry that the program no longer has", () => {
			const smaller = new Command("agx");
			smaller.command("search [query]").action(() => undefined);
			const problems = unclassified(walkProgram(smaller));
			expect(problems).toContain('SLOT_TABLE lists command "login", which the program no longer has');
			expect(problems).toContain('SLOT_TABLE lists "search" --capability, which the program no longer has');
		});

		it("stays quiet for a command that repeats nothing", async () => {
			const noisy: string[] = [];
			for (const form of FORMS) {
				for (const json of [false, true]) {
					const observed = await observeLeaky("clean", plant(form, "clean"), json);
					if (observed.threw || observed.channels.size > 0) {
						noisy.push(`clean | ${form} | ${json ? "--json" : "human"}: ${observed.threw ?? [...observed.channels].join(", ")}`);
					}
				}
			}
			expect(noisy).toEqual([]);
		}, LONG);

		it("starts every command with the throwaway relay and not the stock one", async () => {
			const show = () => ({ args: ["config", "show"], stdin: null });
			const ours = await runOnce(show, { ...plant("nsec", "relay"), needles: [world.relayUrl] }, false);
			expect(ours.threw).toBeNull();
			expect([...ours.channels]).toContain("stdout");
			const stock = await runOnce(show, { ...plant("nsec", "relay"), needles: ["127.0.0.1:7447"] }, false);
			expect(stock.threw).toBeNull();
			expect([...stock.channels]).toEqual([]);
		}, LONG);

		it("stops a connection to a port that is never touched, and to any other machine", () => {
			expect(blockedReason("127.0.0.1", 7447)).toBe("port");
			expect(blockedReason("localhost", 53505)).toBe("port");
			expect(blockedReason("::1", 7447)).toBe("port");
			expect(blockedReason("relay.example.org", 7447)).toBe("port");
			expect(blockedReason("relay.example.org", 443)).toBe("name");
			expect(blockedReason("192.0.2.1", 80)).toBe("name");
			expect(blockedReason("127.0.0.1", 40123)).toBeNull();
			expect(blockedReason("localhost", null)).toBeNull();
		});

		it("tells which port a server is asked to listen on", () => {
			expect(listenPortOf([7447, "127.0.0.1"])).toBe(7447);
			expect(listenPortOf(["53505"])).toBe(53505);
			expect(listenPortOf([{ port: 7447, host: "::1" }])).toBe(7447);
			expect(listenPortOf([{ port: "0" }])).toBe(0);
			expect(listenPortOf([0, () => undefined])).toBe(0);
			expect(listenPortOf([{ path: "/tmp/a.sock" }, () => undefined])).toBeNull();
			expect(listenPortOf([() => undefined])).toBeNull();
			expect(listenPortOf([])).toBeNull();
		});

		it("refuses a server that listens, and a socket that connects, to a port that is never touched", async () => {
			// A free port of this machine's own, made off limits for the length of this test: the real ones are never used.
			const free = await new Promise<number>((resolve) => {
				const probe = net.createServer();
				probe.listen(0, "127.0.0.1", () => {
					const { port } = probe.address() as AddressInfo;
					probe.close(() => resolve(port));
				});
			});
			const undo = forbidPortForTest(free);
			const before = world.attempts.length;
			try {
				const listened = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
					const server = net.createServer();
					server.once("error", resolve);
					server.listen(free, "127.0.0.1", () => server.close(() => resolve(null)));
				});
				expect(listened?.code).toBe("EACCES");
				const connected = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
					const socket = net.connect({ host: "127.0.0.1", port: free });
					socket.once("error", resolve);
					socket.once("connect", () => {
						socket.destroy();
						resolve(null);
					});
				});
				expect(connected?.code).toBe("ECONNREFUSED");
				expect(world.attempts.slice(before).map((attempt) => `${attempt.host}:${attempt.port}:${attempt.blocked}`)).toEqual([`listen:${free}:port`, `127.0.0.1:${free}:port`]);
			} finally {
				undo();
				world.attempts.splice(before);
			}
		});

		it("credits a file to a request only when it holds the key more often than before", async () => {
			const box = sandbox();
			const lines: string[] = [];
			let writes = 0;
			const echo = createServer((req, res) => {
				// Always the same file, with new text each time: a request that replaces the copy of the key it finds, and adds none.
				writeFileSync(join(box.home, "held.txt"), `asked: ${decodeURIComponent(req.url ?? "")} (${(writes += 1)})`);
				res.end("done");
			});
			await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
			try {
				const probe = HTTP_PROBES.find((candidate) => candidate.slot === "GET /v1/tasks/:id") as HttpProbe;
				const wrong: string[] = [];
				for (const form of FORMS) {
					// A key of its own for every form: the file still holds the last form's key, which is not this one.
					const planted = plant(form, `replace|${form}`);
					const watch: HttpWatch = { url: `http://127.0.0.1:${(echo.address() as AddressInfo).port}`, key: "none", home: box.home, lines, skip: new Set(), tree: readTree(box.home) };
					const first = await sendProbe(watch, probe, planted);
					const second = await sendProbe(watch, probe, planted);
					if (!first.channels.has("file-content")) {
						wrong.push(`${form}: the request that wrote the first copy was not credited`);
					}
					if (second.channels.has("file-content")) {
						wrong.push(`${form}: the request that replaced the copy was credited`);
					}
				}
				expect(wrong).toEqual([]);
			} finally {
				await new Promise<void>((resolve) => echo.close(() => resolve()));
				box.restore();
			}
		});

		it("sees a lookup that code makes through a named import, and refuses it", async () => {
			// `subscriptions.ts` does `import { lookup } from "node:dns/promises"`: a name imported like that is the guard's
			// only if the guard says so to Node (`syncBuiltinESMExports`). Checked first, so that no lookup goes out when it is not.
			expect(namedLookup).toBe(dns.promises.lookup);
			const before = world.attempts.length;
			try {
				await expect(namedLookup("canary-named.invalid")).rejects.toMatchObject({ code: "ENOTFOUND" });
				// And the code that does it: a webhook whose host is a name, as a subscription may carry.
				await assertWebhookHost("http://canary-webhook.invalid/hook");
				expect(world.attempts.slice(before).map((attempt) => `${attempt.host}:${attempt.blocked}`)).toEqual(["canary-named.invalid:name", "canary-webhook.invalid:name"]);
			} finally {
				world.attempts.splice(before);
			}
		});

		it("sees a key in an HTTP answer, in the gateway's log and in a file it changes while it answers", async () => {
			const box = sandbox();
			const lines: string[] = [];
			let kept = 0;
			const echo = createServer((req, res) => {
				// What the gateway does with a path: take one level of escaping off before it uses it.
				const asked = decodeURIComponent(req.url ?? "");
				lines.push(`${req.method} ${asked}`);
				// And a file that is there while the request is answered and gone by the time the gateway stops.
				// A counter in the name: the file system may not tell `abc` from `ABC`, and each request is to leave a file of its own.
				writeFileSync(join(box.home, `${asked.replaceAll("/", "_")}.${(kept += 1)}`), `asked: ${asked}`);
				res.end(`you asked for ${asked}`);
			});
			await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
			try {
				const probe = HTTP_PROBES.find((candidate) => candidate.slot === "GET /v1/tasks/:id") as HttpProbe;
				const missed: string[] = [];
				for (const form of FORMS) {
					const planted = plant(form, "echo");
					const watch: HttpWatch = {
						url: `http://127.0.0.1:${(echo.address() as AddressInfo).port}`,
						key: "none",
						home: box.home,
						lines,
						skip: new Set(),
						tree: readTree(box.home),
					};
					const sent = await sendProbe(watch, probe, planted);
					for (const channel of ["response", "log", "file-name", "file-content"] as const) {
						if (!sent.channels.has(channel)) {
							missed.push(`${form}: not seen in ${channel}`);
						}
					}
				}
				expect(missed).toEqual([]);
			} finally {
				await new Promise<void>((resolve) => echo.close(() => resolve()));
				box.restore();
			}
		});
	});

	it("has a WebSocket for code that does not bring its own, on every Node version", () => {
		expect(typeof globalThis.WebSocket).toBe("function");
	});

	describe("the cleanup and the home", () => {
		it("recognises the ways a program can reach a resolver or start a process", () => {
			for (const text of ['import { lookup } from "node:dns/promises";', "import dns from 'node:dns';", "dns.resolve4(host)", "dns.resolve(host, cb)", "await dns.promises.resolve(host)", "await dns.promises.resolveTxt(name)", "const r = new Resolver();", "new dns.promises.Resolver()", "resolveSrv(name)"]) {
				expect(usesResolver(text), text).toBe(true);
			}
			for (const text of ["const resolved = resolve(path);", "await lookupHost(name)", "// dns is not used here"]) {
				expect(usesResolver(text), text).toBe(false);
			}
			expect(usesChildProcess('import { spawn } from "node:child_process";')).toBe(true);
			expect(usesChildProcess("const child = 1;")).toBe(false);
		});

		it("knows what the connection guard does not watch: other resolver calls and child processes", () => {
			const { root, files } = sourceFiles();
			const resolvers: string[] = [];
			const children: string[] = [];
			for (const file of files) {
				const text = readFileSync(file, "utf8");
				if (usesResolver(text)) {
					resolvers.push(relative(root, file));
				}
				if (usesChildProcess(text)) {
					children.push(relative(root, file));
				}
			}
			// A new use of either is a way out the guard does not see: add it to the guard, or write here why it is harmless.
			// Both of these use `lookup` of `node:dns/promises`: `subscriptions.ts` through a named import and `ssrf.ts` through a
			// dynamic one, read when it is first needed. The guard's `syncBuiltinESMExports()` is what makes either see the guard.
			expect(resolvers).toEqual(["cli/src/lib/gateway/subscriptions.ts", "nostr/src/ssrf.ts"]);
			expect(children).toEqual(["cli/src/commands/ui.ts", "cli/src/lib/browser.ts", "cli/src/relay/cert.ts"]);
		});

		it("gives every run a home of its own, and the tester's home is not in it", async () => {
			let seen: { agx: string; os: string; env: Record<string, string | undefined> } | null = null;
			const observed = await runOnce(() => ({ args: [], stdin: null }), plant("nsec", "home"), false, {
				run: async () => {
					seen = { agx: process.env.AGX_HOME as string, os: homedir(), env: { ...process.env } };
					return 0;
				},
			});
			expect(observed.threw).toBeNull();
			const run = seen as unknown as { agx: string; os: string; env: Record<string, string | undefined> };
			expect(run.agx).not.toBe("");
			expect(REAL_HOME.startsWith(run.agx)).toBe(false);
			expect(run.os).toBe(run.agx);
			// Every variable a program takes for a home or a settings folder is in the throwaway home, so none leads to the tester's.
			const outside = HOME_VARIABLES.filter((name) => !(run.env[name] ?? "").startsWith(run.agx));
			expect(outside).toEqual([]);
			expect(Object.entries(run.env).filter(([name, value]) => (HOME_VARIABLES as readonly string[]).includes(name) && value?.startsWith(REAL_HOME))).toEqual([]);
			expect(run.env.TS_AUTHKEY).toBeUndefined();
		});

		it("knows every place in the source that asks where a home or a settings folder is", () => {
			const { root, files } = sourceFiles();
			const asks: string[] = [];
			const names = new Set<string>();
			for (const file of files) {
				const text = readFileSync(file, "utf8");
				if (/\bhomedir\(/.test(text)) {
					asks.push(relative(root, file));
				}
				for (const match of text.matchAll(/process\.env\.([A-Za-z_0-9]+)/g)) {
					const name = match[1] as string;
					if (!name.startsWith("AGX_") && HOME_LIKE.test(name)) {
						names.add(name);
					}
				}
			}
			// A new place, or a new variable: decide whether a run must give it the throwaway home (`pointHomeAt`), then list it here.
			expect(asks).toEqual(["cli/src/lib/paths.ts"]);
			expect([...names].filter((name) => !(HOME_VARIABLES as readonly string[]).includes(name) && name !== "TMPDIR")).toEqual([]);
		});

		it("removes the folders this file made, and only those", () => {
			const parent = mkdtempSync(join(tmpdir(), "agx-canary-check-"));
			const mine = join(parent, "mine");
			const other = join(parent, "other");
			mkdirSync(mine);
			mkdirSync(other);
			writeFileSync(join(mine, "file"), "x");
			const known = homesMade.length;
			homesMade.push(mine);
			try {
				removeMade();
				expect(existsSync(mine)).toBe(false);
				expect(existsSync(other)).toBe(true);
				expect(existsSync(parent)).toBe(true);
			} finally {
				homesMade.splice(known);
				rmSync(parent, { recursive: true, force: true });
			}
		});
	});

	describe("the lists", () => {
		const universe = { slots: new Set(["a | --x", "a | --y", "b | --x"]) };
		const line = (command: string, slot: string, reason = "why"): KnownLeak => ({ command, slot, forms: ["nsec"], channels: ["stdout"], reason });

		it("expands every combination a line spells out", () => {
			const both: KnownLeak = { command: "a", slot: "--x", forms: ["nsec", "hex"], channels: ["stdout", "request"], reason: "why" };
			const { tuples, problems } = expand([both], universe);
			expect(problems).toEqual([]);
			expect([...tuples.keys()].sort()).toEqual(["a | --x | hex | request", "a | --x | hex | stdout", "a | --x | nsec | request", "a | --x | nsec | stdout"]);
		});

		it("asks for a reason, a slot that is probed, each combination once and the right order", () => {
			expect(expand([line("a", "--x", "  ")], universe).problems).toEqual(["no reason given for a | --x: say why it is listed"]);
			expect(expand([line("a", "--z")], universe).problems).toEqual(['"a" has no slot "--z" that is probed']);
			expect(expand([line("a", "--x"), line("a", "--x")], universe).problems).toEqual(["listed twice: a | --x | nsec | stdout"]);
			expect(expand([line("b", "--x"), line("a", "--y")], universe).problems).toEqual(['out of order: "a | --y" comes before "b | --x"']);
			expect(expand([line("a", "--y"), line("a", "--x")], universe).problems).toEqual(['out of order: "a | --x" comes before "a | --y"']);
			expect(expand([line("a", "--x"), line("a", "--y"), line("b", "--x")], universe).problems).toEqual([]);
		});

		it("asks that a reason about a pull request fits the slot and the forms it is on", () => {
			const real = { slots: new Set(["search | [query]", "search | --limit", "gateway (HTTP API) | GET /v1/tasks/:id", "search | <unknown option>"]) };
			const on = (command: string, slot: string, reason: string, forms: KnownLeak["forms"] = ["nsec"]): KnownLeak => ({ command, slot, forms, channels: ["stdout"], reason });
			expect(expand([on("search", "[query]", WHY.pr65)], real).problems).toEqual([]);
			expect(expand([on("search", "<unknown option>", WHY.pr61, OWN)], real).problems).toEqual([]);
			// the reason of one pull request on the slot of another
			expect(expand([on("search", "[query]", WHY.pr61)], real).problems).toHaveLength(2);
			expect(expand([on("search", "--limit", WHY.pr65)], real).problems).toHaveLength(1);
			// a pull request that is about one command, on another
			expect(expand([on("search", "[query]", WHY.pr75)], real).problems).toHaveLength(1);
			expect(expand([on(GATEWAY_API, "GET /v1/tasks/:id", WHY.pr75)], real).problems).toEqual([]);
			// the forms the pull request does not touch
			expect(expand([on("search", "[query]", WHY.pr65, ["hex"])], real).problems).toHaveLength(1);
			expect(expand([on("search", "[query]", WHY.ownHex, ["nsec"])], real).problems).toHaveLength(1);
		});

		it("lets INTENDED hold only a slot that takes a secret", () => {
			const nodes = walkProgram(buildProgram());
			const intended = (command: string, slot: string): KnownLeak => ({ command, slot, forms: ["nsec"], channels: ["request"], reason: "kept on purpose" });
			expect(intendedProblems([intended("identity import", "[secret]")], nodes)).toEqual([]);
			expect(intendedProblems([intended("search", "[query]")], nodes)).toEqual([expect.stringContaining('its class in SLOT_TABLE is "text", not "secret"')]);
			expect(intendedProblems([intended("search", "--profile")], nodes)).toEqual([expect.stringContaining('is "profile", not "secret"')]);
		});

		it("asks for one verdict per slot, an honest reason on it and a verdict behind every reason in the table", () => {
			const expected = new Map<string, string | null>([["a | --x", null], ["a | --y", "why not"]]);
			const texts = new Map<string, string[]>([["a", ["why not"]]]);
			const verdict = (slot: string, reached: boolean, reason: string | null) => ({ command: "a", slot, reached, reason });
			const fine = [verdict("--x", true, null), verdict("--y", false, "why not")];
			expect(reachProblems(expected, texts, fine)).toEqual([]);
			expect(reachProblems(expected, texts, [verdict("--x", true, null)])).toEqual(["no verdict on whether the command used it: a | --y", "a reason in SLOT_TABLE that no verdict of \"a\" carries: why not"]);
			expect(reachProblems(expected, texts, [...fine, verdict("--x", true, null)])).toEqual(["2 verdicts for one slot: a | --x"]);
			expect(reachProblems(expected, texts, [...fine, verdict("--z", true, null)])).toEqual(["a verdict for a slot that is not probed: a | --z"]);
			expect(reachProblems(expected, texts, [verdict("--x", true, null), verdict("--y", false, null)])).toEqual([
				"the reason of a | --y is not the one in SLOT_TABLE",
				"never reached, so its clean result means nothing: a | --y (give the command what it needs in SLOT_TABLE, or say why it cannot be reached with `unproven`)",
				"a reason in SLOT_TABLE that no verdict of \"a\" carries: why not",
			]);
			expect(reachProblems(expected, texts, [verdict("--x", false, null), verdict("--y", false, "why not")])).toHaveLength(1);
		});
	});

	describe("the comparison with the lists", () => {
		const leak = "a | --x | nsec | stdout";
		const other = "a | --y | hex | request";
		const listed = (...tuples: string[]) => new Map(tuples.map((tuple) => [tuple, "why"] as const));

		it("accepts exactly what is listed", () => {
			expect(compare(new Set([leak, other]), listed(leak), listed(other))).toEqual([]);
		});

		it("reports a leak that is not listed", () => {
			expect(compare(new Set([leak, other]), listed(leak), listed())).toEqual(["new leak, not in KNOWN_LEAKS: a | --y (request: hex)"]);
		});

		it("reports a listed leak that is gone, and says to remove it", () => {
			expect(compare(new Set([other]), listed(leak), listed(other))).toEqual(["no longer leaks, remove it from KNOWN_LEAKS: a | --x (stdout: nsec); listed because: why"]);
		});

		it("reports an intended slot that no longer stores or sends the key, and says to remove it", () => {
			expect(compare(new Set([leak]), listed(leak), listed(other))).toEqual(["no longer stored or sent, remove it from INTENDED: a | --y (request: hex); listed because: why"]);
		});

		it("reports a combination that is in both lists", () => {
			expect(compare(new Set([leak]), listed(leak), listed(leak))).toEqual(["in both KNOWN_LEAKS and INTENDED: a | --x (stdout: nsec)"]);
		});

		it("says it once for a slot, with its channels and forms, in order", () => {
			const found = new Set(["b | --x | hex | request", "a | --x | nsec | stdout", "a | --x | hex | stdout", "a | --x | nsec | stderr", "a | --y | nsec | stdout"]);
			expect(compare(found, listed(), listed())).toEqual([
				"new leak, not in KNOWN_LEAKS: a | --x (stderr: nsec; stdout: hex, nsec)",
				"new leak, not in KNOWN_LEAKS: a | --y (stdout: nsec)",
				"new leak, not in KNOWN_LEAKS: b | --x (request: hex)",
			]);
		});
	});

	describe("the detector", () => {
		const planted = plant("nsec");
		const data = planted.value.slice("nsec1".length);

		it("finds a 10-character stretch of the key and not a 9-character one", () => {
			expect(holdsKey(`before ${data.slice(7, 17)} after`, planted.needles)).toBe(true);
			expect(holdsKey(`before ${data.slice(7, 16)} after`, planted.needles)).toBe(false);
		});

		it("finds it in either case", () => {
			expect(holdsKey(data.slice(3, 23).toUpperCase(), planted.needles)).toBe(true);
		});

		it("finds it after %xx decoding, behind a nostr: prefix, and in a sentence", () => {
			expect(holdsKey(percentEscapeAll(data.slice(3, 23)), planted.needles)).toBe(true);
			expect(holdsKey(`nostr:${planted.value}`, planted.needles)).toBe(true);
			expect(holdsKey(`my key is ${planted.value} and please keep it safe`, planted.needles)).toBe(true);
		});

		it("finds the profile's own key written as hex, nsec1… or npub1…", () => {
			const own = plant("hex");
			const bytes = hexToBytes(own.value);
			expect(holdsKey(own.value.toUpperCase(), own.needles)).toBe(true);
			expect(holdsKey(nip19.nsecEncode(bytes), own.needles)).toBe(true);
			expect(holdsKey(nip19.npubEncode(own.value), own.needles)).toBe(true);
		});

		it("counts the prefix as part of the key: a stretch that runs into it is found", () => {
			// `nsec1` and 5 characters of key data is a 10-character stretch of the key; with 4 it is not enough.
			expect(holdsKey(`"${planted.value.slice(0, 10)}"... is not valid JSON`, planted.needles)).toBe(true);
			expect(holdsKey(`"${planted.value.slice(0, 9)}"... is not valid JSON`, planted.needles)).toBe(false);
			const protectedKey = plant("ncryptsec");
			// For `ncryptsec1` the first characters of data are the same in every string (the cost), so it takes 8.
			expect(holdsKey(protectedKey.value.slice(8, 18), protectedKey.needles)).toBe(true);
			expect(holdsKey(protectedKey.value.slice(7, 17), protectedKey.needles)).toBe(false);
			// In capitals as well.
			const capitals = plant("NSEC");
			expect(capitals.value.startsWith("NSEC1")).toBe(true);
			expect(holdsKey(capitals.value.slice(0, 10), capitals.needles)).toBe(true);
		});

		it("does not take the prefix every key shares for a key", () => {
			for (const form of ["nsec", "ncryptsec", "NSEC"] as const) {
				const needles = plant(form).needles;
				expect(holdsKey("give an nsec1… or an ncryptsec1… key, or 64 hex characters", needles)).toBe(false);
				expect(holdsKey("NSEC1 and NCRYPTSEC1 and nostr:nsec1, then 5 words", needles)).toBe(false);
				expect(holdsKey("the key starts with nsec1 and is 63 characters long", needles)).toBe(false);
			}
		});

		it("holds every planted form's own value, in the shape it claims", () => {
			const shapes: Record<Form, RegExp> = {
				nsec: /^nsec1[0-9a-z]{58}$/,
				ncryptsec: /^ncryptsec1[0-9a-z]+$/,
				hex: /^[0-9a-f]{64}$/,
				HEX: /^[0-9A-F]{64}$/,
				nostr: /^nostr:nsec1[0-9a-z]{58}$/,
				escaped: /^(%[0-9A-F]{2}){63}$/,
				sentence: /^my key is nsec1[0-9a-z]{58} and please keep it safe$/,
				NSEC: /^NSEC1[0-9A-Z]{58}$/,
			};
			for (const form of FORMS) {
				const value = plant(form);
				expect(value.value).toMatch(shapes[form]);
				expect(holdsKey(value.value, value.needles)).toBe(true);
				expect(holdsKey(mask(value.value), value.needles)).toBe(false);
			}
		});
	});
});
