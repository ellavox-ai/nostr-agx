import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { hexToBytes, toNpub } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile, saveProfile } from "../lib/config.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { setStdinForTests } from "../lib/stdin.js";
import { agx, sandbox } from "./helpers.js";

// A secret key typed into a slot that is not a secret slot is refused after the command line is
// parsed and before any command runs: exit 2, a fixed message that names the slot, nothing printed
// of the value, nothing written, nothing sent. Every key here is made when the test runs.

let box: ReturnType<typeof sandbox>;
let server: Server;
let received: string[];
const mine = createIdentity();
const stranger = createIdentity();
const friend = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(stranger.secretKeyHex));
const OTHER_NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
const NCRYPTSEC = `ncryptsec1${"q".repeat(30)}${stranger.secretKeyHex.slice(0, 30).replace(/[0-9]/g, "q")}`;
const STRANGER_HEX = stranger.secretKeyHex;
const OWN_HEX = mine.secretKeyHex;
const OWN_NPUB_OF_SECRET = toNpub(OWN_HEX);
const FRIEND = friend.npub;
const FRIEND_HEX = friend.publicKey;
const PEER_ARGS = ["--slug", "demo-agent"];

/** Every file under `home`, with a digest of its content: what a command left behind. */
function snapshot(home: string): string {
	const rows: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const rel = relative(home, path);
			if (lstatSync(path).isDirectory()) {
				rows.push(`${rel}/`);
				walk(path);
			} else {
				rows.push(`${rel} ${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12)}`);
			}
		}
	};
	walk(home);
	return rows.join("\n");
}

/** The first 10-character stretch of the key's data part found in `shown`, in any case, also after %xx decoding; null if none. */
function leakedPart(shown: string, key: string, from = 5): string | null {
	const text = shown.toLowerCase();
	const decoded = text.replace(/%([0-9a-f]{2})/g, (_all, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)));
	const secret = key.toLowerCase();
	for (let i = from; i + 10 <= secret.length; i++) {
		const part = secret.slice(i, i + 10);
		if (text.includes(part) || decoded.includes(part)) {
			return part;
		}
	}
	return null;
}

beforeEach(async () => {
	box = sandbox();
	saveIdentity("default", mine);
	received = [];
	// A loopback stand-in for the index. It records every request and refuses it.
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			received.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString("utf8")}`);
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { code: "rejected", message: "rejected" } }));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	process.env.AGX_API_URL = `http://127.0.0.1:${port}`;
	process.env.AGX_API_KEY = "throwaway-test-key";
	process.env.AGX_ORG = "acme";
	// Nothing here may reach the default relay port: this one refuses at once.
	process.env.AGX_RELAY = "ws://127.0.0.1:9";
});

afterEach(async () => {
	await new Promise<void>((done) => server.close(() => done()));
	box.restore();
});

// -------------------------------------------------------------------------- the messages

const LEFT = ", so it was not used and is not shown here.";
const SECRET_KEY = (slot: string): string => `${slot} holds a secret key (nsec1… or ncryptsec1…)${LEFT}`;
const HEX_RUN = (slot: string): string => `${slot} holds a 64-character hex string, which may be a secret key${LEFT}`;
const OWN_KEY = (slot: string): string => `${slot} holds this profile's own secret key${LEFT}`;
const NOT_A_NAME = (slot: string): string =>
	`${slot} is not a valid profile name (1 to 32 letters, digits, "-", "_" or "."; not "." or ".."), so it was not used and is not shown here.`;
const KEY_REMEDIATION = "A secret key belongs only in `agx identity import` (pipe it in with --stdin). Check what each command takes with `agx --help`.";
const NAME_REMEDIATION = "Use a short name, for example:  agx -p work identity new";
const NOT_AN_ENV_NAME = (slot: string): string =>
	`${slot} is not a valid environment variable name (letters, digits and "_", not starting with a digit), so it was not used and is not shown here.`;
const ENV_NAME_REMEDIATION = "Name the variable that holds the key, for example:  agx identity import --from-env AGENT_KEY";
const option = (name: string, command: string): string => `The value of \`${name}\` (agx ${command})`;
const argument = (name: string, command: string): string => `The \`${name}\` argument (agx ${command})`;
const variable = (name: string): string => `The environment variable ${name}`;

interface Row {
	name: string;
	args: string[];
	env?: Record<string, string>;
	message: string;
	remediation?: string;
	/** Strings that must not show anywhere in what the command printed. */
	secrets?: string[];
}

function refusedRows(): Row[] {
	const keyed = (name: string, args: string[], slot: string, extra: Partial<Row> = {}): Row => ({
		name,
		args,
		message: SECRET_KEY(slot),
		remediation: KEY_REMEDIATION,
		secrets: [NSEC],
		...extra,
	});
	return [
		// profile names
		keyed("--profile", ["--profile", NSEC, "identity", "new"], "The value of `--profile`"),
		keyed("-p", ["-p", NSEC, "config", "list"], "The value of `--profile`"),
		keyed("config use", ["config", "use", NSEC], argument("<profile>", "config use")),
		keyed("AGX_PROFILE", ["config", "list"], variable("AGX_PROFILE"), { env: { AGX_PROFILE: NSEC } }),
		// paths and names that reach the Tailscale launcher
		keyed("tailscale up --state-dir", ["tailscale", "up", "--state-dir", `/${NSEC}/x`, "--auth-key", "tskey-auth-not-real"], option("--state-dir", "tailscale up")),
		keyed("tailscale up --hostname", ["tailscale", "up", "--hostname", NSEC, "--auth-key", "tskey-auth-not-real"], option("--hostname", "tailscale up")),
		keyed("tailscale enable --state-dir", ["tailscale", "enable", "--no-up", "--state-dir", NSEC], option("--state-dir", "tailscale enable")),
		keyed("tailscale enable --oauth-client-id", ["tailscale", "enable", "--no-up", "--oauth-client-id", NSEC], option("--oauth-client-id", "tailscale enable")),
		keyed("AGX_TAILSCALE_STATE_DIR", ["config", "list"], variable("AGX_TAILSCALE_STATE_DIR"), { env: { AGX_TAILSCALE_STATE_DIR: `/tmp/${NSEC}` } }),
		keyed("AGX_TAILSCALE_HOSTNAME", ["config", "list"], variable("AGX_TAILSCALE_HOSTNAME"), { env: { AGX_TAILSCALE_HOSTNAME: NSEC } }),
		// other environment variables
		keyed("AGX_RELAY", ["config", "list"], variable("AGX_RELAY"), { env: { AGX_RELAY: `ws://127.0.0.1:9/${NSEC}` } }),
		keyed("AGX_ORG", ["config", "list"], variable("AGX_ORG"), { env: { AGX_ORG: NSEC } }),
		keyed("AGX_API_URL", ["config", "list"], variable("AGX_API_URL"), { env: { AGX_API_URL: `http://127.0.0.1:9/${NSEC}` } }),
		// free text that is sent to the index or stored
		keyed("search", ["search", NSEC], argument("[query]", "search")),
		keyed("config set org", ["config", "set", "org", NSEC], argument("[value]", "config set")),
		keyed("config set relays", ["config", "set", "relays", `ws://127.0.0.1:9/${NSEC}`], argument("[value]", "config set")),
		keyed("register --display-name", ["register", ...PEER_ARGS, "--display-name", NSEC], option("--display-name", "register")),
		keyed("identity register --summary", ["identity", "register", ...PEER_ARGS, "--summary", NSEC], option("--summary", "identity register")),
		keyed("listing create --description", ["listing", "create", ...PEER_ARGS, "--description", NSEC], option("--description", "listing create")),
		keyed("domain add --handle", ["domain", "add", "example.com", "--handle", NSEC], option("--handle", "domain add")),
		keyed("peers refuse --reason", ["peers", "refuse", "--team", "t1", "--peer", "p1", "--reason", NSEC], option("--reason", "peers refuse")),
		keyed("identity sign", ["identity", "sign", NSEC], argument("<nonce>", "identity sign")),
		keyed("org create", ["org", "create", NSEC], argument("<name>", "org create")),
		keyed("gateway key new --label", ["gateway", "key", "new", "--label", NSEC], option("--label", "gateway key new")),
		// identifiers and paths
		keyed("serve --capability", ["serve", "--capability", NSEC, "--once"], option("--capability", "serve")),
		keyed("serve --handler", ["serve", "--handler", `/tmp/${NSEC}.js`, "--once"], option("--handler", "serve")),
		keyed("gateway key revoke", ["gateway", "key", "revoke", NSEC], argument("<id>", "gateway key revoke")),
		keyed("listing get", ["listing", "get", NSEC], argument("[listingId]", "listing get")),
		keyed("domain verify", ["domain", "verify", NSEC], argument("<domainId>", "domain verify")),
		keyed("peers list --team", ["peers", "list", "--team", NSEC], option("--team", "peers list")),
		keyed("thread", ["thread", NSEC], argument("<contextId>", "thread")),
		keyed("inbox --thread", ["inbox", "--thread", NSEC], option("--thread", "inbox")),
		keyed("send --context-id", ["send", "--context-id", NSEC, FRIEND, "hello"], option("--context-id", "send")),
		keyed("card --relay", ["card", FRIEND, "--relay", `ws://127.0.0.1:9/${NSEC}`], option("--relay", "card")),
		keyed("ui --compose", ["ui", "--no-open", "--compose", `/tmp/${NSEC}.json`], option("--compose", "ui")),
		// the name of the variable that holds a key to import: a key typed there is refused, and is not used as a name
		keyed("identity import --from-env", ["identity", "import", "--from-env", NSEC], option("--from-env", "identity import")),
		keyed("identity import --from-env in capitals", ["identity", "import", "--from-env", NSEC.toUpperCase()], option("--from-env", "identity import")),
		keyed("identity import --from-env=<nsec>", ["identity", "import", `--from-env=${NSEC}`], option("--from-env", "identity import")),
		keyed("identity import --from-env <ncryptsec>", ["identity", "import", "--from-env", NCRYPTSEC], option("--from-env", "identity import"), { secrets: [NCRYPTSEC] }),
		{ name: "identity import --from-env <hex>", args: ["identity", "import", "--from-env", `a${STRANGER_HEX.slice(1)}`], message: HEX_RUN(option("--from-env", "identity import")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		{ name: "identity import --from-env <hex in capitals>", args: ["identity", "import", "--from-env", STRANGER_HEX.toUpperCase()], message: HEX_RUN(option("--from-env", "identity import")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		{ name: "identity import --from-env <hex, one digit short>", args: ["identity", "import", "--from-env", `a${STRANGER_HEX.slice(2)}`], message: NOT_AN_ENV_NAME(option("--from-env", "identity import")), remediation: ENV_NAME_REMEDIATION, secrets: [STRANGER_HEX] },
		{ name: "identity import --from-env <a letter and 55 hex digits>", args: ["identity", "import", "--from-env", `x${STRANGER_HEX.slice(0, 55)}`], message: NOT_AN_ENV_NAME(option("--from-env", "identity import")), remediation: ENV_NAME_REMEDIATION, secrets: [STRANGER_HEX.slice(0, 55)] },
		{ name: "identity import --from-env <nsec1 typed without its 1>", args: ["identity", "import", "--from-env", NSEC.replace("nsec1", "nsec")], message: NOT_AN_ENV_NAME(option("--from-env", "identity import")), remediation: ENV_NAME_REMEDIATION, secrets: [NSEC.slice(5, 30)] },
		{ name: "identity import --from-env <41 characters>", args: ["identity", "import", "--from-env", "Z".repeat(41)], message: NOT_AN_ENV_NAME(option("--from-env", "identity import")), remediation: ENV_NAME_REMEDIATION },
		...["1KEY", "MY-KEY", "MY KEY", "KEY=1", "$HOME", ""].map((name) => ({
			name: `identity import --from-env ${JSON.stringify(name)}`,
			args: ["identity", "import", "--from-env", name],
			message: NOT_AN_ENV_NAME(option("--from-env", "identity import")),
			remediation: ENV_NAME_REMEDIATION,
		})),
		// a peer slot: refused before, with another message
		keyed("identity allow", ["identity", "allow", NSEC], argument("[peers...]", "identity allow")),
		keyed("identity deny", ["identity", "deny", NSEC], argument("<peers...>", "identity deny")),
		keyed("held allow", ["held", "allow", NSEC], argument("<npub>", "held allow")),
		keyed("send <peer>", ["send", NSEC, "hello"], argument("<peer>", "send")),
		keyed("request <peer>", ["request", NSEC, "x.y"], argument("<peer>", "request")),
		keyed("card <peer>", ["card", NSEC], argument("<peer>", "card")),
		keyed("serve --allow", ["serve", "--allow", NSEC, "--once"], option("--allow", "serve")),
		keyed("listing create --pubkey", ["listing", "create", ...PEER_ARGS, "--pubkey", NSEC], option("--pubkey", "listing create")),
		keyed("peers allowlist --npub", ["peers", "allowlist", "--team", "t1", "--npub", NSEC], option("--npub", "peers allowlist")),
		// the other forms of a key
		keyed("in capitals", ["config", "use", NSEC.toUpperCase()], argument("<profile>", "config use")),
		keyed("behind nostr:", ["search", `nostr:${NSEC}`], argument("[query]", "search")),
		keyed("as %xx escapes", ["search", [...NSEC].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join("")], argument("[query]", "search")),
		keyed("inside a sentence", ["search", `my key is ${NSEC} ok`], argument("[query]", "search")),
		keyed("an ncryptsec1", ["search", NCRYPTSEC], argument("[query]", "search"), { secrets: [NCRYPTSEC] }),
		keyed("two keys", ["search", `${NSEC} ${OTHER_NSEC}`], argument("[query]", "search"), { secrets: [NSEC, OTHER_NSEC] }),
		keyed("--json", ["--json", "search", NSEC], argument("[query]", "search")),
		// 64 hex digits where only an identifier belongs
		{ name: "--profile <hex>", args: ["--profile", STRANGER_HEX, "identity", "new"], message: HEX_RUN("The value of `--profile`"), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		{ name: "config use <hex>", args: ["config", "use", STRANGER_HEX], message: HEX_RUN(argument("<profile>", "config use")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		{ name: "AGX_PROFILE <hex>", args: ["config", "list"], env: { AGX_PROFILE: STRANGER_HEX }, message: HEX_RUN(variable("AGX_PROFILE")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		// a --profile typed on the command line wins over AGX_PROFILE, which is then not used as a name, but a key in it is still refused
		{ name: "AGX_PROFILE <nsec> with --profile typed", args: ["--profile", "work", "identity", "show"], env: { AGX_PROFILE: NSEC }, message: SECRET_KEY(variable("AGX_PROFILE")), remediation: KEY_REMEDIATION, secrets: [NSEC] },
		{ name: "AGX_PROFILE <hex> with --profile typed", args: ["--profile", "work", "identity", "show"], env: { AGX_PROFILE: STRANGER_HEX }, message: HEX_RUN(variable("AGX_PROFILE")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		{ name: "AGX_PROFILE <own hex> with --profile typed", args: ["--profile", "work", "identity", "show"], env: { AGX_PROFILE: OWN_HEX }, message: HEX_RUN(variable("AGX_PROFILE")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		{ name: "domain list --org <hex>", args: ["domain", "list", "--org", STRANGER_HEX], message: HEX_RUN(option("--org", "domain list")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		{ name: "gateway key revoke <hex>", args: ["gateway", "key", "revoke", STRANGER_HEX], message: HEX_RUN(argument("<id>", "gateway key revoke")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		// an id or a switch in the environment is refused like the option of the same name, not let through as a place
		{ name: "AGX_ORG <hex> (listing list)", args: ["listing", "list"], env: { AGX_ORG: STRANGER_HEX }, message: HEX_RUN(variable("AGX_ORG")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		{ name: "AGX_TAILSCALE_HOSTNAME <hex>", args: ["config", "list"], env: { AGX_TAILSCALE_HOSTNAME: STRANGER_HEX }, message: HEX_RUN(variable("AGX_TAILSCALE_HOSTNAME")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
		{ name: "AGX_UI_DEV_STORE <hex>", args: ["config", "list"], env: { AGX_UI_DEV_STORE: STRANGER_HEX }, message: HEX_RUN(variable("AGX_UI_DEV_STORE")), remediation: KEY_REMEDIATION, secrets: [STRANGER_HEX] },
						// the profile's own secret key in a path or a URL, where a stranger's 64 hex digits are a hash
		{ name: "tailscale up --state-dir <own hex>", args: ["tailscale", "up", "--state-dir", `/x/${OWN_HEX}`, "--auth-key", "tskey-auth-not-real"], message: OWN_KEY(option("--state-dir", "tailscale up")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		{ name: "tailscale up --state-dir </%own hex>", args: ["tailscale", "up", "--state-dir", `/x/%${OWN_HEX}`, "--auth-key", "tskey-auth-not-real"], message: OWN_KEY(option("--state-dir", "tailscale up")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		{ name: "card --relay <own hex>", args: ["card", FRIEND, "--relay", `ws://127.0.0.1:9/${OWN_HEX}`], message: OWN_KEY(option("--relay", "card")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		{ name: "AGX_TAILSCALE_STATE_DIR <own hex>", args: ["config", "list"], env: { AGX_TAILSCALE_STATE_DIR: `/tmp/${OWN_HEX}` }, message: OWN_KEY(variable("AGX_TAILSCALE_STATE_DIR")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		{ name: "AGX_RELAY <own hex>", args: ["config", "list"], env: { AGX_RELAY: `ws://127.0.0.1:9/${OWN_HEX.toUpperCase()}` }, message: OWN_KEY(variable("AGX_RELAY")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		{ name: "AGX_ORG <own hex> (an id: a 64-digit run)", args: ["config", "list"], env: { AGX_ORG: OWN_HEX }, message: HEX_RUN(variable("AGX_ORG")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		// an option of a command that has subcommands, typed before the subcommand
		keyed("gateway --host (typed before `key list`)", ["gateway", "--host", NSEC, "key", "list"], option("--host", "gateway")),
		// the profile's own secret key where a public key, an id or text belongs
		{ name: "card <own hex>", args: ["card", OWN_HEX], message: OWN_KEY(argument("<peer>", "card")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "card <own hex in capitals>", args: ["card", OWN_HEX.toUpperCase()], message: OWN_KEY(argument("<peer>", "card")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "card <npub of the own key's bytes>", args: ["card", OWN_NPUB_OF_SECRET], message: OWN_KEY(argument("<peer>", "card")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "send <own hex>", args: ["send", OWN_HEX, "hello"], message: OWN_KEY(argument("<peer>", "send")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "request <own hex>", args: ["request", OWN_HEX, "x.y"], message: OWN_KEY(argument("<peer>", "request")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "identity allow <own hex>", args: ["identity", "allow", OWN_HEX], message: OWN_KEY(argument("[peers...]", "identity allow")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "identity deny <own hex>", args: ["identity", "deny", OWN_HEX], message: OWN_KEY(argument("<peers...>", "identity deny")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "held allow <own hex>", args: ["held", "allow", OWN_HEX], message: OWN_KEY(argument("<npub>", "held allow")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "serve --allow <own hex>", args: ["serve", "--allow", OWN_HEX, "--once"], message: OWN_KEY(option("--allow", "serve")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "listing create --pubkey <own hex>", args: ["listing", "create", ...PEER_ARGS, "--pubkey", OWN_HEX], message: OWN_KEY(option("--pubkey", "listing create")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "peers allowlist --npub <own hex>", args: ["peers", "allowlist", "--team", "t1", "--npub", OWN_HEX], message: OWN_KEY(option("--npub", "peers allowlist")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX, OWN_NPUB_OF_SECRET] },
		{ name: "search <own hex> (free text)", args: ["search", `find ${OWN_HEX} please`], message: OWN_KEY(argument("[query]", "search")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		{ name: "thread <own hex> (a slot that takes ids)", args: ["thread", OWN_HEX], message: OWN_KEY(argument("<contextId>", "thread")), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		{ name: "--profile <own hex>", args: ["--profile", OWN_HEX, "config", "list"], message: HEX_RUN("The value of `--profile`"), remediation: KEY_REMEDIATION, secrets: [OWN_HEX] },
		// profile names that are not one short folder name
		...["../escape", "a/b", "/etc", "..", ".", "my profile", "work@acme", "a:b", "x".repeat(33), "é", ""].map((name) => ({
			name: `--profile ${JSON.stringify(name.length > 12 ? `${name.slice(0, 12)}…` : name)}`,
			args: ["--profile", name, "identity", "new"],
			message: NOT_A_NAME("The value of `--profile`"),
			remediation: NAME_REMEDIATION,
		})),
		{ name: "config use <name with a slash>", args: ["config", "use", "a/b"], message: NOT_A_NAME(argument("<profile>", "config use")), remediation: NAME_REMEDIATION },
		{ name: "AGX_PROFILE empty", args: ["config", "list"], env: { AGX_PROFILE: "" }, message: NOT_A_NAME(variable("AGX_PROFILE")), remediation: NAME_REMEDIATION },
		{ name: "AGX_PROFILE <name with a space>", args: ["config", "list"], env: { AGX_PROFILE: "my profile" }, message: NOT_A_NAME(variable("AGX_PROFILE")), remediation: NAME_REMEDIATION },
	];
}

describe("a secret key in a slot that is not a secret slot", () => {
	it.each(refusedRows().map((row) => [row.name, row] as const))("%s: refused, exit 2, a fixed message, nothing printed, written or sent", async (_name, row) => {
		for (const [name, value] of Object.entries(row.env ?? {})) {
			process.env[name] = value;
		}
		const before = snapshot(box.home);
		const run = await agx(...row.args);
		expect(run.code).toBe(2);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(`\n✗ ${row.message}\n\n  ${row.remediation}\n\n`);
		for (const secret of row.secrets ?? []) {
			expect(leakedPart(run.stdout + run.stderr, secret, secret.startsWith("nsec1") || secret.startsWith("ncryptsec1") ? 5 : 0)).toBeNull();
		}
		expect(snapshot(box.home)).toBe(before);
		expect(received).toEqual([]);
	});

	it("does not create the profile folder, or config.json, for a key given as the profile name", async () => {
		const run = await agx("--profile", NSEC, "identity", "new");
		expect(run.code).toBe(2);
		expect(existsSync(join(box.home, "profiles", NSEC))).toBe(false);
		expect(existsSync(join(box.home, "profiles", "..", "escape"))).toBe(false);
		const escape = await agx("--profile", "../escape", "identity", "new");
		expect(escape.code).toBe(2);
		expect(existsSync(join(box.home, "escape"))).toBe(false);
	});

	it("says nothing more in --json mode: stdout stays empty and the same one message goes to standard error", async () => {
		const plain = await agx("search", NSEC);
		const asJson = await agx("--json", "search", NSEC);
		expect(asJson.code).toBe(2);
		expect(asJson.stdout).toBe("");
		expect(asJson.stderr).toBe(plain.stderr);
	});

	it("does not change the exit code a bad argument already had", async () => {
		// The same code `agx send <nsec> hello` ended with before the check: a usage error.
		expect((await agx("send", NSEC, "hello")).code).toBe(2);
	});
});

// ------------------------------------------------------------------------------ allowed

describe("what still goes through", () => {
	it("imports a secret key from the command line, from standard input, and from standard input as an nsec", async () => {
		const first = await agx("--profile", "imported", "identity", "import", NSEC);
		expect(first.code).toBe(0);
		expect(first.stdout).toContain("npub1");
		const restore = setStdinForTests(`${OTHER_NSEC}\n`);
		try {
			const second = await agx("--profile", "from-stdin", "identity", "import", "--stdin");
			expect(second.code).toBe(0);
		} finally {
			restore();
		}
	});

	it.each([
		["an API key typed as a value", ["config", "set", "apiKey", "ela_throwaway_value_1234"]],
		["a Tailscale key", ["tailscale", "enable", "--no-up", "--auth-key", "tskey-auth-throwaway"]],
	])("takes %s in a secret slot, not refused by the check", async (_name, args) => {
		const run = await agx(...args);
		expect(run.stderr).not.toContain("is not shown here");
		expect(run.stderr).not.toContain("was not used");
	});

	it("still sends a message body and a request payload as typed (the decision about them is open)", async () => {
		const withKey = await agx("send", FRIEND, `my key is ${NSEC} ok`);
		expect(withKey.stderr).not.toContain("was not used");
		const withPayload = await agx("request", FRIEND, "x.y", "--payload", JSON.stringify({ k: NSEC }));
		expect(withPayload.stderr).not.toContain("was not used");
		const withSubject = await agx("send", "--subject", NSEC, FRIEND, "hello");
		expect(withSubject.stderr).not.toContain("was not used");
	});

	it("takes a 64-digit id in the three thread-id slots", async () => {
		for (const args of [
			["thread", STRANGER_HEX],
			["inbox", "--thread", STRANGER_HEX, "--wait", "1"],
			["send", "--context-id", STRANGER_HEX, FRIEND, "hello"],
		]) {
			const run = await agx(...args);
			expect(run.stderr, args.join(" ").slice(0, 20)).not.toContain("was not used");
		}
	});

	it("takes a public key as hex or npub, and the profile's own public key", async () => {
		for (const args of [
			["card", FRIEND_HEX],
			["card", FRIEND],
			["card", mine.npub],
			["identity", "allow", FRIEND_HEX],
			["held", "allow", FRIEND],
		]) {
			const run = await agx(...args);
			expect(run.stderr, args.join(" ").slice(0, 24)).not.toContain("was not used");
		}
		expect(JSON.parse(readFileSync(join(box.home, "config.json"), "utf8")).profiles.default.allow).toContain(FRIEND_HEX);
	});

	it("takes ordinary text, ids and paths", async () => {
		const search = await agx("search", "invoice review");
		expect(search.stderr).not.toContain("was not used");
		expect(received.length).toBeGreaterThan(0);
		const set = await agx("config", "set", "org", "Acme Corp");
		expect(set.code).toBe(0);
		expect(set.stdout).toBe('✓ Set org on profile "default".\n');
	});
});

describe("a content hash in a folder, a file name or a URL", () => {
	const HASH = createHash("sha256").update("a lock file").digest("hex");

	it.each([
		["AGX_HOME", (home: string) => ({ AGX_HOME: join(home, HASH) })],
		["AGX_TAILSCALE_STATE_DIR", (home: string) => ({ AGX_TAILSCALE_STATE_DIR: join(home, HASH, "ts") })],
		["AGX_RELAY", () => ({ AGX_RELAY: `ws://127.0.0.1:9/${HASH}` })],
		["AGX_API_URL", () => ({ AGX_API_URL: `http://127.0.0.1:9/${HASH}` })],
		["AGX_ELLADEX_URL", () => ({ AGX_ELLADEX_URL: `https://elladex.example/${HASH}` })],
		["AGX_TAILSCALE_BINARY", (home: string) => ({ AGX_TAILSCALE_BINARY: join(home, HASH, "tailscale") })],
	])("%s: every command still runs", async (_name, make) => {
		Object.assign(process.env, make(box.home));
		const run = await agx("config", "list");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
	});

	it("takes the hash in the state folder of `tailscale enable` and in a relay URL of `card`", async () => {
		const enable = await agx("tailscale", "enable", "--no-up", "--auth-key", "tskey-auth-throwaway", "--state-dir", join(box.home, HASH, "ts"));
		expect(enable.code).toBe(0);
		expect(enable.stderr).not.toContain("was not used");
		for (const args of [
			["card", FRIEND, "--relay", `ws://127.0.0.1:9/${HASH}`],
		]) {
			const run = await agx(...args);
			expect(run.stderr, args.slice(0, 2).join(" ")).not.toContain("was not used");
		}
	});

	it("still refuses a key shape and the profile's own key in the same places", async () => {
		const state = await agx("tailscale", "enable", "--no-up", "--auth-key", "tskey-auth-throwaway", "--state-dir", join(box.home, NSEC, "ts"));
		expect(state.code).toBe(2);
		expect(state.stderr).toContain("holds a secret key");
		const own = await agx("tailscale", "enable", "--no-up", "--auth-key", "tskey-auth-throwaway", "--state-dir", join(box.home, OWN_HEX, "ts"));
		expect(own.code).toBe(2);
		expect(own.stderr).toContain("holds this profile's own secret key");
		expect(own.stderr).not.toContain(OWN_HEX);
	});
});

describe("AGX_PROFILE and --profile", () => {
	it.each([
		["an empty text", ""],
		["a name with a space", "my profile"],
	])("a --profile typed on the command line wins, so AGX_PROFILE set to %s is never used as a name and is accepted", async (_name, value) => {
		process.env.AGX_PROFILE = value;
		const run = await agx("--profile", "work", "config", "list");
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
	});

	it("an empty AGX_PROFILE alone is still refused: the empty name is the folder that holds every profile", async () => {
		process.env.AGX_PROFILE = "";
		const run = await agx("config", "list");
		expect(run.code).toBe(2);
		expect(run.stderr).toBe(`\n✗ ${NOT_A_NAME(variable("AGX_PROFILE"))}\n\n  ${NAME_REMEDIATION}\n\n`);
	});
});

describe("a profile that is already stored and has a name the rule does not allow", () => {
	/** Made the way an older build made it: the folder, the identity and the name in config.json. */
	function storedBefore(name: string): void {
		saveIdentity(name, createIdentity());
		saveProfile(name, getProfile(name));
	}

	it("can be chosen again with config use, --profile and AGX_PROFILE, after another profile became the current one", async () => {
		await agx("config", "use", "default");
		storedBefore("my profile");
		const use = await agx("config", "use", "my profile");
		expect(use.code).toBe(0);
		expect((await agx("config", "use", "default")).code).toBe(0);
		const flag = await agx("--profile", "my profile", "identity", "show");
		expect(flag.code).toBe(0);
		expect(flag.stdout).toContain("my profile");
		process.env.AGX_PROFILE = "my profile";
		const env = await agx("identity", "show");
		expect(env.code).toBe(0);
		expect(env.stdout).toContain("my profile");
	});

	it("does not let a new profile be made with a name like it", async () => {
		storedBefore("my profile");
		for (const name of ["my other profile", "my profile "]) {
			const run = await agx("--profile", name, "identity", "new");
			expect(run.code, name).toBe(2);
			expect(existsSync(join(box.home, "profiles", name))).toBe(false);
		}
	});

	it("is refused when its name holds a key shape, 64 hex digits or a slash", async () => {
		storedBefore(NSEC);
		storedBefore(STRANGER_HEX);
		storedBefore("a/b");
		for (const name of [NSEC, STRANGER_HEX, "a/b"]) {
			const run = await agx("config", "use", name);
			expect(run.code, name.slice(0, 6)).toBe(2);
			expect(run.stderr).not.toContain(name);
		}
	});
});

describe("profile names that work", () => {
	it.each(["work", "a", "n8n-demo", "demo_requester", "v1.2", "claude-company-memory", ".hidden", "a..b", "x".repeat(32), "A1"])("%s", async (name) => {
		const run = await agx("--profile", name, "identity", "new");
		expect(run.code).toBe(0);
		expect(existsSync(join(box.home, "profiles", name, "identity.json"))).toBe(true);
		const use = await agx("config", "use", name);
		expect(use.code).toBe(0);
	});

	it("keeps the stored active profile as it is: a name saved before this check is not looked at", async () => {
		await agx("config", "use", "legacy");
		const config = JSON.parse(readFileSync(join(box.home, "config.json"), "utf8"));
		config.currentProfile = "my old profile";
		config.profiles["my old profile"] = config.profiles.legacy;
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(box.home, "config.json"), JSON.stringify(config));
		const run = await agx("config", "list");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("my old profile");
	});
});
