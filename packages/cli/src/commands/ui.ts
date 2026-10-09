import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { effectiveProfile, getProfile, resolveProfileName, updateProfile } from "../lib/config.js";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { loadIdentity } from "../lib/identity.js";
import { neutralizeControls } from "../lib/inbound-lines.js";
import { acquireLock } from "../lib/lock.js";
import { info, json, kv, ok, say, warn } from "../lib/output.js";
import { profileDir } from "../lib/paths.js";
import { toDisplayNpub, toHexPubkey } from "../lib/peer.js";
import { MessageStore } from "../lib/store/message-store.js";
import { createTransport, makeLogger } from "../lib/transport.js";
import type { AgentLookup, ApiDeps } from "../lib/ui/api.js";
import { createAgxStore } from "../lib/ui/agx-store.js";
import { type AgxSync, createAgxSync } from "../lib/ui/agx-sync.js";
import { createDevStore } from "../lib/ui/dev-store.js";
import {
	DEFAULT_DRAFT_DIR,
	loadDraftFile,
} from "../lib/ui/drafts.js";
import { startUiServer, type UiAssets } from "../lib/ui/server.js";
import type { UiStore } from "../lib/ui/store.js";

export interface UiOptions {
	profile?: string;
	port?: string;
	/** Commander's `--no-open` sets this to false. */
	open?: boolean;
	compose?: string;
	drafts?: string;
	/** Minutes of inactivity before the UI exits. 0 disables. */
	idle?: string;
	/** Interim store file for trying the UI before `agx inbox` ships. */
	devStore?: string;
	verbose?: boolean;
}

const DEFAULT_ELLADEX_URL = "https://app.ellaworks.ai";
const SYNC_EVERY_MS = 30_000;

/**
 * `agx ui`: a local browser UI for the user's own conversations.
 *
 * Start it in your own terminal, not from an assistant's sandbox: a server
 * started there would block the turn and may lack network access. It binds
 * 127.0.0.1 only and every request needs the session cookie and CSRF header
 * (see lib/ui/security.ts). The assistant never sends: it leaves draft files
 * and the user presses Send here.
 */
export async function uiCommand(options: UiOptions): Promise<void> {
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const identity = loadIdentity(profileName);

	// The real message store, or a JSON file for trying the UI without a profile's mail.
	// The real one takes the profile lock, so `serve` and `inbox` cannot run beside it.
	let store: UiStore;
	let releaseLock: () => void = () => undefined;
	let closeSync: () => Promise<void> = async () => undefined;
	if (options.devStore) {
		store = createDevStore(resolve(options.devStore));
	} else {
		releaseLock = acquireLock(profileName, EXIT.generic);
		try {
			const messages = new MessageStore(profileDir(profileName), undefined, { claimSpool: true });
			const loadAllow = (): string[] =>
				getProfile(profileName).allow.map((entry) => toHexPubkey(entry, "allowlist entry"));
			const allowed = new Set(loadAllow());
			const refreshAllowed = (): void => {
				allowed.clear();
				for (const hex of loadAllow()) {
					allowed.add(hex);
				}
			};
			let pull: AgxSync | null = null;
			store = createAgxStore({
				dir: profileDir(profileName),
				store: messages,
				allowed,
				loadAllow,
				changeAllow: (hex, on) => {
					const current = getProfile(profileName).allow.filter((entry) => toHexPubkey(entry, "allowlist entry") !== hex);
					updateProfile(profileName, { allow: on ? [...current, hex] : current });
				},
				sync: async () => {
					pull ??= await createAgxSync({
						profileName,
						profile: getProfile(profileName),
						identity,
						store: messages,
						allowed,
						beforePull: refreshAllowed,
						verbose: options.verbose ?? false,
					});
					return pull.sync();
				},
			});
			closeSync = async () => {
				await pull?.close();
				messages.flush();
			};
		} catch (error) {
			releaseLock();
			throw error;
		}
	}

	try {
		const port = options.port === undefined ? 0 : Number(options.port);
		if (!Number.isInteger(port) || port < 0 || port > 65535) {
			throw new AgxCliError(`--port must be an integer from 0 to 65535, got "${options.port}".`, { exitCode: EXIT.usage });
		}
		const idleMinutes = options.idle === undefined ? 60 : Number(options.idle);
		if (!Number.isFinite(idleMinutes) || idleMinutes < 0) {
			throw new AgxCliError(`--idle must be a number of minutes, got "${options.idle}".`, { exitCode: EXIT.usage });
		}

		let composeDraft = null;
		if (options.compose) {
			try {
				composeDraft = loadDraftFile(resolve(options.compose));
			} catch (error) {
				throw new AgxCliError(
					`Could not load the draft: ${error instanceof Error ? error.message : String(error)}`,
					{ exitCode: EXIT.usage, remediation: 'A draft is JSON: {"to": "npub1…", "body": "…", "subject": "…", "contextId": "…"}' },
				);
			}
		}
		const draftsDir = options.drafts
			? resolve(options.drafts)
			: existsSync(resolve(DEFAULT_DRAFT_DIR))
				? resolve(DEFAULT_DRAFT_DIR)
				: null;

		const deps: ApiDeps = {
			store,
			draftsDir,
			composeDraft,
			toNpub: (input) => toDisplayNpub(toHexPubkey(input.trim(), "recipient")),
			identity: () => ({
				profile: profileName,
				npub: identity.npub,
				relays: profile.relays,
				doctor: { status: "unknown", detail: "Run `agx doctor` for a full check." },
			}),
			send: async ({ to, subject, contextId, body }) => {
				const transport = await createTransport(profile, identity, makeLogger(options.verbose ?? false));
				const res = await transport.publishMessage(toHexPubkey(to, "recipient"), {
					text: body,
					subject: subject ?? null,
					contextId: contextId ?? null,
					contentType: DEFAULT_CONTENT_TYPE,
				});
				if (res.ok) {
					return { ok: true, detail: null, eventId: res.eventId, contextId: res.contextId ?? null };
				}
				const detail = (res.rejected ?? []).map((r) => `${r.relay} (${r.error})`).join("; ") || (res.errors ?? []).join("; ") || "unknown error";
				return { ok: false, detail };
			},
			lookupAgent: lookupElladexAgent,
		};

		const assets = loadAssets();
		const server = await startUiServer({
			api: deps,
			assets: () => assets,
			port,
			idleMs: idleMinutes * 60 * 1000,
			syncEveryMs: SYNC_EVERY_MS,
			onSyncError: (error) => warn(`Could not pull new messages: ${safeMessage(error)}`),
			onIdle: () => {
				say(`No activity for ${idleMinutes} minutes; stopping.`);
				void shutdown();
			},
		});

		let launchFile: string | null = null;
		const removeLaunchFile = (): void => {
			if (launchFile) {
				rmSync(launchFile, { force: true });
			}
		};
		let closing = false;
		async function shutdown(): Promise<void> {
			if (closing) {
				return;
			}
			closing = true;
			try {
				await server.close();
				await closeSync();
			} catch (error) {
				warn(`Stopping was not clean: ${safeMessage(error)}`);
			} finally {
				releaseLock();
				removeLaunchFile();
				process.exit(0);
			}
		}
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			process.once(signal, () => void shutdown());
		}

		ok(`agx ui is running on http://127.0.0.1:${server.port} (loopback only)`);
		kv("profile", profileName);
		if (options.open === false) {
			// Asked for explicitly. The link is a one-time bearer secret: anyone who can read this output can use it first.
			kv("link", server.url);
			info("The link works once. Press Ctrl-C to stop.");
			json({ ok: true, port: server.port, url: server.url });
		} else {
			info("Opening your browser. If nothing opens, run `agx ui --no-open` to print the one-time link. Press Ctrl-C to stop.");
			json({ ok: true, port: server.port });
			launchFile = openBrowserWithToken(server.url, () => {
				warn("Could not open a browser. Run `agx ui --no-open` and open the link it prints.");
			});
		}
		// Keep the process alive until shutdown.
		await new Promise<void>(() => undefined);
	} catch (error) {
		// Anything that fails after the lock is taken (a bad --port, a missing asset, a busy port) must free it.
		await closeSync().catch(() => undefined);
		releaseLock();
		throw error;
	}
}

function loadAssets(): UiAssets {
	const here = dirname(fileURLToPath(import.meta.url));
	const dir = join(here, "ui");
	const read = (name: string): string => {
		const path = join(dir, name);
		if (!existsSync(path)) {
			throw new AgxCliError(`The UI files are missing (${path}).`, {
				exitCode: EXIT.generic,
				remediation: "Reinstall @nostr-agx/cli, or run `pnpm --filter @nostr-agx/cli build` in a checkout.",
			});
		}
		return readFileSync(path, "utf8");
	};
	return { html: read("index.html"), js: read("app.js"), css: read("app.css") };
}

const MAX_LOOKUP_BYTES = 64 * 1024;

/** The directory URL: https, or http only for a local test server. */
function elladexBase(): string | null {
	const raw = (process.env.AGX_ELLADEX_URL ?? DEFAULT_ELLADEX_URL).replace(/\/+$/, "");
	try {
		const url = new URL(raw);
		const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
		return url.protocol === "https:" || (url.protocol === "http:" && local) ? raw : null;
	} catch {
		return null;
	}
}

function cleanText(value: unknown): string | null {
	return typeof value === "string" ? neutralizeControls(value).slice(0, 200) : null;
}

async function lookupElladexAgent(query: string): Promise<AgentLookup | null> {
	const base = elladexBase();
	if (!base) {
		return null;
	}
	let text: string;
	try {
		const response = await fetch(`${base}/api/elladex/agents/${encodeURIComponent(query.trim())}`, {
			headers: { accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) {
			return null;
		}
		text = await response.text();
	} catch {
		return null;
	}
	if (text.length > MAX_LOOKUP_BYTES) {
		return null;
	}
	let listing: Record<string, unknown> | undefined;
	try {
		listing = (JSON.parse(text) as { listing?: Record<string, unknown> }).listing;
	} catch {
		return null;
	}
	if (!listing || typeof listing.npub !== "string") {
		return null;
	}
	// The answer must be about what was asked: a valid key, and the same handle or address.
	let address: string;
	try {
		address = toDisplayNpub(toHexPubkey(listing.npub, "listing"));
	} catch {
		return null;
	}
	const handle = cleanText(listing.handle);
	const asked = query.trim().toLowerCase();
	const matches = asked.includes("@")
		? handle?.toLowerCase() === asked
		: toDisplayNpub(asked) === address;
	if (!matches) {
		return null;
	}
	return {
		address,
		handle,
		verified: listing.verified === true,
		displayName: cleanText(listing.displayName),
		summary: cleanText(listing.summary),
	};
}

/** An error text that is safe to print: control characters neutralised, short. */
function safeMessage(error: unknown): string {
	const text = neutralizeControls(error instanceof Error ? error.message : String(error));
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Open the browser without putting the one-time token in argv (visible to `ps`) or on stdout:
 * a private 0600 page that redirects to the link. It is removed after a minute and on exit.
 */
function openBrowserWithToken(url: string, onFailure: () => void): string | null {
	const file = join(tmpdir(), `agx-ui-${randomBytes(8).toString("hex")}.html`);
	try {
		writeFileSync(
			file,
			`<!doctype html><meta charset="utf-8"><title>agx ui</title><p>Opening agx ui…</p><script>location.replace(${JSON.stringify(url)})</script>\n`,
			{ mode: 0o600 },
		);
	} catch {
		onFailure();
		return null;
	}
	const [command, args] =
		process.platform === "darwin"
			? ["open", [file]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", file]]
				: ["xdg-open", [file]];
	try {
		const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
		child.on("error", onFailure);
		child.on("exit", (code) => {
			if (code !== 0) {
				onFailure();
			}
		});
		child.unref();
	} catch {
		onFailure();
	}
	setTimeout(() => rmSync(file, { force: true }), 60_000).unref();
	return file;
}
