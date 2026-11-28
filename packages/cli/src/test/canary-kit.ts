import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { join, relative, sep } from "node:path";
import { bytesToHex, hexToBytes } from "@nostr-agx/nostr";
import type { Command } from "commander";
import { nip19 } from "nostr-tools";
import { getConversationKey } from "nostr-tools/nip44";
import { encrypt } from "nostr-tools/nip49";
import { vi } from "vitest";
import { type IdentityFile, identityFromSecret } from "../lib/identity.js";

/**
 * Test-only parts of the secret-key canary: the key forms it plants, the
 * detector that looks for them, a reader for the files a run leaves behind, a
 * walker over the command tree and a guard that keeps every probe on this
 * machine. The canary itself is `secret-canary.test.ts`.
 *
 * Every key here is made when the test runs, from a fixed text (see `identityFor`): none
 * is real, none is written to a file in the repository, and none is ever printed in full.
 */

// ------------------------------------------------------------------- key forms

/**
 * The ways a pasted key can look. `hex` and `HEX` are the profile's OWN secret
 * key (an exact value the CLI could know); the others are keys of a stranger,
 * which only their shape can give away. A stranger's 64-hex key cannot be told
 * from a public key, which is why it is not planted. `NSEC` is the same key
 * written in capitals, which bech32 allows.
 */
export const FORMS = ["nsec", "ncryptsec", "hex", "HEX", "nostr", "escaped", "sentence", "NSEC"] as const;
export type Form = (typeof FORMS)[number];

export const FORM_DESCRIPTION: Record<Form, string> = {
	nsec: "nsec1…",
	ncryptsec: "ncryptsec1… (password-protected)",
	hex: "64 hex characters, lower case (the profile's own key)",
	HEX: "64 hex characters, upper case (the profile's own key)",
	nostr: "nostr:nsec1…",
	escaped: "nsec1… with every character %xx-escaped",
	sentence: "nsec1… inside a longer sentence",
	NSEC: "NSEC1… in capitals",
};

/** How many characters of a key must show up for a run to count as a leak. */
export const WINDOW = 10;

/** Every `size`-character stretch of `data`, lower case. */
export function windowsOf(data: string, size = WINDOW): string[] {
	const text = data.toLowerCase();
	const out: string[] = [];
	for (let i = 0; i + size <= text.length; i++) {
		out.push(text.slice(i, i + size));
	}
	return out;
}

/**
 * Every `size`-character stretch of the encoded key `text` (lower case) that holds
 * at least `minData` characters of key data after the `prefixLength`-character
 * prefix. The prefix is part of the key's text, so a stretch that runs into it
 * counts; a stretch of the prefix alone is what every key of that kind starts with
 * and is not the key, which keeps help text that names `nsec1` or `ncryptsec1` clean.
 */
export function windowsWithPrefix(text: string, prefixLength: number, minData = 5, size = WINDOW): string[] {
	const lower = text.toLowerCase();
	const out: string[] = [];
	for (let i = 0; i + size <= lower.length; i++) {
		if (i + size - prefixLength >= minData) {
			out.push(lower.slice(i, i + size));
		}
	}
	return out;
}

/** `%xx` for every character of `text`. */
export function percentEscapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/** `text` with every valid `%xx` sequence replaced by its character; a bad one is left alone. */
export function percentDecode(text: string): string {
	return text.replace(/%([0-9a-f]{2})/gi, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export interface Planted {
	form: Form;
	/** What is typed (or piped) into the slot. */
	value: string;
	/** Lower-case stretches of the key, in every shape it could come back in. */
	needles: string[];
	/** The identity the sandbox profile is given: the planted key itself for `hex` and `HEX`. */
	identity: IdentityFile;
}

const NSEC_PREFIX = "nsec1".length;
const NCRYPTSEC_PREFIX = "ncryptsec1".length;
/**
 * The first 16 bits after `ncryptsec1` (version and cost) are the same for every string made with
 * the same cost, and the next bits are the salt: with fewer than 8 characters of data, another
 * string made by the same program would match too. 8 characters hold 24 bits that belong to this key.
 */
const NCRYPTSEC_MIN_DATA = 8;
const NPUB_PREFIX = "npub1".length;

/** Every shape the same 32 secret bytes can come back in: hex, nsec1… and npub1… (a secret read as a public key). */
function needlesOfSecret(secretHex: string): string[] {
	const bytes = hexToBytes(secretHex);
	return [
		...windowsOf(secretHex),
		...windowsWithPrefix(nip19.nsecEncode(bytes), NSEC_PREFIX),
		...windowsWithPrefix(nip19.npubEncode(secretHex), NPUB_PREFIX),
	];
}

const ANY_SECRET = hexToBytes("11".repeat(32));

/** A secret key that, read as a public key, is a point on the curve (about half of all 64-hex values are not). */
function isPublicKeyToo(secretHex: string): boolean {
	try {
		getConversationKey(ANY_SECRET, secretHex);
		return true;
	} catch {
		return false;
	}
}

/**
 * A throwaway identity made from `label`, `role` and a counter: the same text gives
 * the same key on every run, so a run that is repeated finds the same leaks. The
 * profile's own key (`hex`, `HEX`) is picked so that it is also
 *   - a valid public key: a command that takes it as a peer then goes on to use it, and
 *   - hex that starts with a letter: a parser that quotes the start of a word it
 *     cannot read (JSON.parse quotes ten characters) shows it, as it would for any
 *     such key. A key that starts with a digit is read as a number first and is not quoted.
 */
function identityFor(label: string, role: "own" | "stranger", asHex: boolean): IdentityFile {
	for (let n = 0; ; n++) {
		const secret = new Uint8Array(createHash("sha256").update(`secret-canary|${label}|${role}|${n}`).digest());
		const hex = bytesToHex(secret);
		if (asHex && !(/^[a-f]/.test(hex) && isPublicKeyToo(hex))) {
			continue;
		}
		try {
			return identityFromSecret(secret, "generated");
		} catch {
			// not a usable secret key (practically never): the next counter gives another
		}
	}
}

/**
 * A throwaway key in `form`, with what to look for. `label` says where it is for:
 * every slot gets its own key, the same one on every run.
 */
export function plant(form: Form, label = ""): Planted {
	if (form === "hex" || form === "HEX") {
		// The key the profile holds, pasted by mistake: hex, nsec and npub of the same bytes all count.
		const own = identityFor(label, "own", true);
		return {
			form,
			value: form === "hex" ? own.secretKeyHex : own.secretKeyHex.toUpperCase(),
			needles: needlesOfSecret(own.secretKeyHex),
			identity: own,
		};
	}
	const own = identityFor(label, "own", false);
	const stranger = identityFor(label, "stranger", false);
	const secret = hexToBytes(stranger.secretKeyHex);
	if (form === "ncryptsec") {
		// A real NIP-49 string from a throwaway key and password (scrypt cost 2^4: quick). Salt and nonce are random.
		const value = encrypt(secret, "throwaway-password", 4);
		return { form, value, needles: windowsWithPrefix(value, NCRYPTSEC_PREFIX, NCRYPTSEC_MIN_DATA), identity: own };
	}
	const nsec = nip19.nsecEncode(secret);
	const needles = needlesOfSecret(bytesToHex(secret));
	const value =
		form === "nsec"
			? nsec
			: form === "NSEC"
				? nsec.toUpperCase()
				: form === "nostr"
					? `nostr:${nsec}`
					: form === "escaped"
						? percentEscapeAll(nsec)
						: `my key is ${nsec} and please keep it safe`;
	return { form, value, needles, identity: own };
}

/** The first four characters of a value: all that may ever be printed of a key. */
export function mask(value: string): string {
	return `${value.slice(0, 4)}…`;
}

// -------------------------------------------------------------------- detector

/**
 * True when any 10-character stretch of the key (any case; also after `%xx`
 * decoding of `text`) appears in `text`. For `nsec1…` and `ncryptsec1…` the stretch
 * may run into the prefix, but must hold 5 (8 for `ncryptsec1…`) characters of key data (see `windowsWithPrefix`).
 */
export function holdsKey(text: string, needles: readonly string[]): boolean {
	if (text === "") {
		return false;
	}
	const lower = text.toLowerCase();
	const decoded = lower.includes("%") ? percentDecode(lower) : lower;
	return needles.some((needle) => lower.includes(needle) || (decoded !== lower && decoded.includes(needle)));
}

/**
 * How many times the key's stretches appear in `text` (a key that appears twice counts double). Used where
 * the same key goes into every request: a file that holds it already is only a new leak when it holds it more often.
 */
export function countKey(text: string, needles: readonly string[]): number {
	if (text === "") {
		return 0;
	}
	const lower = text.toLowerCase();
	const decoded = lower.includes("%") ? percentDecode(lower) : lower;
	let total = 0;
	for (const needle of needles) {
		total += lower.split(needle).length - 1;
		if (decoded !== lower) {
			total += decoded.split(needle).length - 1;
		}
	}
	return total;
}

// ----------------------------------------------------------------------- files

export interface TreeListing {
	/** Every file and folder name below the home, relative, one per line. */
	names: string;
	/** Every file's text, each with its relative path in front. */
	contents: string;
	/** The same, file by file: relative path to text. */
	files: Map<string, string>;
}

/** The names and text in `after` that are new or different since `before`. */
export function changedSince(before: TreeListing, after: TreeListing): { names: string; contents: string } {
	const known = new Set(before.names.split("\n"));
	const names = after.names.split("\n").filter((name) => !known.has(name));
	const contents: string[] = [];
	for (const [rel, text] of after.files) {
		if (before.files.get(rel) !== text) {
			contents.push(`${rel}\n${text}`);
		}
	}
	return { names: names.join("\n"), contents: contents.join("\n") };
}

/** The names and the text of everything under `home`, except the files in `skip` (relative paths). */
export function readTree(home: string, skip: ReadonlySet<string> = new Set()): TreeListing {
	const names: string[] = [];
	const contents: string[] = [];
	const files = new Map<string, string>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const rel = relative(home, full).split(sep).join("/");
			names.push(rel);
			const stat = lstatSync(full);
			if (stat.isDirectory()) {
				walk(full);
			} else if (stat.isFile() && !skip.has(rel) && stat.size <= 4 * 1024 * 1024) {
				const text = readFileSync(full, "utf8");
				files.set(rel, text);
				contents.push(`${rel}\n${text}`);
			}
		}
	};
	walk(home);
	return { names: names.join("\n"), contents: contents.join("\n"), files };
}

// ------------------------------------------------------------- the command tree

export interface SlotInfo {
	/** `--org`, `<peer>`, `[peers...]` */
	name: string;
	kind: "option" | "argument";
	/** False for a flag that takes no value. */
	takesValue: boolean;
	required: boolean;
	variadic: boolean;
	choices: string[] | null;
}

export interface CommandNode {
	/** The words that select it: `["peers", "allowlist"]`; empty for the program itself. */
	path: string[];
	/** `peers allowlist`; `(program)` for the program itself. */
	label: string;
	hasSubcommands: boolean;
	slots: SlotInfo[];
}

/** Every command of the program, itself first, with every option and positional it declares. */
export function walkProgram(program: Command): CommandNode[] {
	const nodes: CommandNode[] = [];
	const visit = (command: Command, path: string[]): void => {
		const slots: SlotInfo[] = [];
		for (const argument of command.registeredArguments) {
			const name = `${argument.name()}${argument.variadic ? "..." : ""}`;
			slots.push({
				name: argument.required ? `<${name}>` : `[${name}]`,
				kind: "argument",
				takesValue: true,
				required: argument.required,
				variadic: argument.variadic,
				choices: argument.argChoices ? [...argument.argChoices] : null,
			});
		}
		for (const option of command.options) {
			slots.push({
				name: option.long ?? option.short ?? option.flags,
				kind: "option",
				takesValue: option.required || option.optional,
				required: option.mandatory,
				variadic: option.variadic,
				choices: option.argChoices ? [...option.argChoices] : null,
			});
		}
		nodes.push({ path, label: path.join(" ") || "(program)", hasSubcommands: command.commands.length > 0, slots });
		for (const sub of command.commands) {
			visit(sub, [...path, sub.name()]);
		}
	};
	visit(program, []);
	return nodes;
}

// ----------------------------------------------------------------- the guard

/** Ports that belong to other work on this machine and are never touched. */
const forbiddenPorts = new Set<number>([7447, 53505]);
export const FORBIDDEN_PORTS: ReadonlySet<number> = forbiddenPorts;

/**
 * Adds a port to the forbidden ones until the returned function is called. Only the
 * controls use it, on a port their own listener holds, to show the guard is wired
 * without ever going near the real ones.
 */
export function forbidPortForTest(port: number): () => void {
	forbiddenPorts.add(port);
	return () => {
		forbiddenPorts.delete(port);
	};
}

export interface ConnectAttempt {
	host: string;
	port: number | null;
	/** Why it was stopped, or null when it went through. */
	blocked: "name" | "port" | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", ""]);

function targetOf(args: unknown[]): { host: string; port: number | null } {
	// net.connect hands `connect` one normalized array [options, callback].
	let first: unknown = args[0];
	if (Array.isArray(first)) {
		first = first[0];
	}
	if (typeof first === "object" && first !== null) {
		const options = first as { host?: unknown; port?: unknown; path?: unknown };
		if (typeof options.path === "string") {
			return { host: "", port: null };
		}
		const port = Number(options.port);
		return { host: typeof options.host === "string" ? options.host : "localhost", port: Number.isFinite(port) ? port : null };
	}
	const port = Number(first);
	return { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number.isFinite(port) ? port : null };
}

/** Why a connection to `host`:`port` is stopped, or null when it may go through. */
export function blockedReason(host: string, port: number | null): ConnectAttempt["blocked"] {
	return FORBIDDEN_PORTS.has(port ?? -1) ? "port" : LOOPBACK_HOSTS.has(host.toLowerCase()) ? null : "name";
}

/** The port a `listen(...)` call asks for, or null when it names none (the system then picks a free one) or a socket file. */
export function listenPortOf(args: unknown[]): number | null {
	const first = args[0];
	const asked = typeof first === "object" && first !== null ? (first as { port?: unknown }).port : first;
	if (asked === undefined || asked === null || asked === "") {
		return null;
	}
	const port = Number(asked);
	return Number.isInteger(port) ? port : null;
}

/**
 * Stops every outgoing TCP connection that is not to this machine (HTTP, WebSocket and TLS all pass
 * through `Socket.connect`), every connection to a port that is never to be touched, and every host-name
 * lookup made through `dns.lookup` or `dns.promises.lookup`, before anything is sent, and records it. A
 * host name looked up would be sent to a resolver, so a key used as a name is a leak the canary can see.
 * A server asked to listen on a port that is never to be touched is stopped the same way.
 *
 * Not watched: the other resolver calls (`dns.resolve*`, `dns.Resolver`) and child processes. No code of
 * the program uses either today (a test of this file reads the source and says so when that changes).
 * `syncBuiltinESMExports()` makes a name imported with `import { lookup } from "node:dns/promises"`
 * the guard's function too: without it such a lookup goes to the system resolver unrecorded.
 *
 * Returns the attempts and the function that puts everything back.
 */
export function guardConnections(): { attempts: ConnectAttempt[]; restore: () => void } {
	const attempts: ConnectAttempt[] = [];
	const realConnect = net.Socket.prototype.connect;
	const connectSpy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
		const { host, port } = targetOf(args);
		const blocked = blockedReason(host, port);
		attempts.push({ host, port, blocked });
		if (blocked) {
			queueMicrotask(() => this.destroy(Object.assign(new Error(`connect ${host}:${port} refused by the canary`), { code: "ECONNREFUSED" })));
			return this;
		}
		return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
	} as typeof net.Socket.prototype.connect);

	const realListen = net.Server.prototype.listen;
	const listenSpy = vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
		const port = listenPortOf(args);
		if (port !== null && FORBIDDEN_PORTS.has(port)) {
			attempts.push({ host: "listen", port, blocked: "port" });
			queueMicrotask(() => this.emit("error", Object.assign(new Error(`listen on ${port} refused by the canary`), { code: "EACCES" })));
			return this;
		}
		return (realListen as (...a: unknown[]) => net.Server).apply(this, args);
	} as typeof net.Server.prototype.listen);

	const realLookup = dns.lookup;
	const lookupSpy = vi.spyOn(dns, "lookup").mockImplementation(((host: string, ...rest: unknown[]) => {
		if (LOOPBACK_HOSTS.has(host.toLowerCase())) {
			return (realLookup as (...a: unknown[]) => unknown)(host, ...rest);
		}
		attempts.push({ host, port: null, blocked: "name" });
		const callback = rest[rest.length - 1] as (error: Error) => void;
		process.nextTick(() => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host })));
		return undefined;
	}) as never);

	const realPromiseLookup = dns.promises.lookup;
	const promiseLookupSpy = vi.spyOn(dns.promises, "lookup").mockImplementation((async (host: string, ...rest: unknown[]) => {
		if (LOOPBACK_HOSTS.has(host.toLowerCase())) {
			return (realPromiseLookup as (...a: unknown[]) => Promise<unknown>)(host, ...rest);
		}
		attempts.push({ host, port: null, blocked: "name" });
		throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host });
	}) as never);

	// `import { lookup } from "node:dns/promises"` keeps the function it was given when the code was loaded,
	// not the one that is on the module object now: it sees the spies only after this call.
	syncBuiltinESMExports();

	return {
		attempts,
		restore: () => {
			connectSpy.mockRestore();
			listenSpy.mockRestore();
			lookupSpy.mockRestore();
			promiseLookupSpy.mockRestore();
			syncBuiltinESMExports();
		},
	};
}
