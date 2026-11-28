/**
 * What kind of value each input of each command takes.
 *
 * Every argument, option and environment variable the CLI reads has one entry. The check in
 * `input-boundary.ts` looks a value up here before any command runs, and refuses a secret
 * key typed into a slot that is not a secret slot. Without an entry a slot is `freeText`.
 *
 * Keys are the words that select the command (`peers allowlist`, `(program)` for the options
 * of `agx` itself) and the slot as the help shows it: `--org`, `<peer>`, `[peers...]`.
 * A test walks the real program and fails when a slot is missing here or has no counterpart.
 */

/**
 * - `secret`: a secret key (or a password or token) is expected here. Not checked.
 * - `publicKey`: an npub or 64 hex digits that name a peer. The profile's own secret key
 *   is the same 64 digits, so it is refused here; any other 64-digit run is a public key.
 * - `identifier`: a name, id, path, URL or number. No key shape belongs, and no 64-hex run except
 *   where the rule says `hexOk` (a thread id, a path, a URL or an environment variable).
 * - `freeText`: words typed by a person. A key shape is refused; a 64-hex run passes, as
 *   an event id or a hash would, except the profile's own secret key.
 */
export type SlotKind = "secret" | "publicKey" | "identifier" | "freeText";

/** What to do with a value that does not belong in the slot. */
export type SlotPolicy = "refuse" | "warn" | "allow";

export interface SlotRule {
	kind: SlotKind;
	/** Default `refuse`. `warn` prints one line on standard error and goes on; `allow` goes on. */
	policy?: SlotPolicy;
	/** An `identifier` that may be 64 hex digits: an event id, or a path or URL where a content hash is normal. A key shape and the profile's own key are still refused. */
	hexOk?: boolean;
	/** The value is a profile name and must also be one short folder name. */
	profileName?: boolean;
}

/** `others` holds the other values of the same command by slot name, for a slot whose kind depends on them. */
export type SlotSpec = SlotKind | SlotRule | ((others: Record<string, unknown>) => SlotKind | SlotRule);

/** Command words, then slot name, then its spec. */
export type SlotTable = Record<string, Record<string, SlotSpec>>;

/**
 * Slots that take an event id, and why: a thread (context) id is chosen by the sender of
 * the first message, so it may be the 64 hex digits of an event id. Everything else that is
 * an id is handed out by the index and is never 64 hex digits.
 */
const THREAD_ID: SlotRule = { kind: "identifier", hexOk: true };

/**
 * A path, a URL or an environment variable: a place, not a name. A content hash in a folder or
 * file name (a cache keyed by a sha256, a build output named by its hash) is 64 hex digits and
 * is normal there, so a stranger's run of 64 hex digits is let through. A key shape and the
 * profile's own key (as hex, also behind a percent sign) are still refused. The environment is
 * looked at on every command, whether or not the command reads a variable, so a false refusal
 * there would stop everything.
 */
const LOCATION: SlotRule = { kind: "identifier", hexOk: true };

/**
 * A message the user means to send. The decision whether a key typed here is refused,
 * warned about or allowed is open: today it is allowed, as `agx send` always did.
 */
const MESSAGE: SlotRule = { kind: "freeText", policy: "allow" };

/** `config set <key> [value]`: the value is a secret for `apiKey` and text for every other key. */
const CONFIG_VALUE = (others: Record<string, unknown>): SlotKind => (others["<key>"] === "apiKey" ? "secret" : "freeText");

const REGISTER: Record<string, SlotSpec> = {
	"--slug": "identifier",
	"--display-name": "freeText",
	"--org": "identifier",
	"--capability": "identifier",
	"--summary": "freeText",
	"--description": "freeText",
	"--use-cases": "freeText",
	"--category": "identifier",
	"--tag": "identifier",
	"--runtime": "identifier",
	"--visibility": "identifier",
	"--handle": "identifier",
	"--domain-id": "identifier",
};

const ORG: Record<string, SlotSpec> = { "--org": "identifier" };

const PEER_DECISION: Record<string, SlotSpec> = {
	"--team": "identifier",
	"--peer": "identifier",
	"--reason": "freeText",
	"--org": "identifier",
};

const HELD: Record<string, SlotSpec> = { "<npub>": "publicKey" };

export const SLOTS: SlotTable = {
	"(program)": { "--profile": { kind: "identifier", profileName: true } },
	login: { "--api-base-url": LOCATION, "--org": "identifier", "--org-name": "freeText", "--org-slug": "identifier" },
	"org create": { "<name>": "freeText", "--slug": "identifier", "--api-base-url": LOCATION },
	"config set": { "<key>": "identifier", "[value]": CONFIG_VALUE, "--stdin": CONFIG_VALUE },
	"config use": { "<profile>": { kind: "identifier", profileName: true } },
	"identity import": { "[secret]": "secret", "--stdin": "secret" },
	"identity sign": { "<nonce>": "freeText" },
	"identity allow": { "[peers...]": "publicKey" },
	"identity deny": { "<peers...>": "publicKey" },
	"identity register": REGISTER,
	register: REGISTER,
	"listing create": {
		"--slug": "identifier",
		"--team": "identifier",
		"--pubkey": "publicKey",
		"--display-name": "freeText",
		"--capability": "identifier",
		"--summary": "freeText",
		"--description": "freeText",
		"--category": "identifier",
		"--tag": "identifier",
		"--runtime": "identifier",
		"--visibility": "identifier",
		"--handle": "identifier",
		"--domain-id": "identifier",
		"--relay": LOCATION,
		"--org": "identifier",
	},
	"listing list": { "--org": "identifier", "--limit": "identifier" },
	"listing get": { "[listingId]": "identifier", ...ORG },
	"listing publish": { "[listingId]": "identifier", ...ORG, "--visibility": "identifier", "--timeout": "identifier" },
	"listing set-visibility": { "<level>": "identifier", "[listingId]": "identifier", ...ORG },
	"listing delist": { "[listingId]": "identifier", ...ORG },
	"listing delete": { "[listingId]": "identifier", ...ORG },
	"listing set-policy": { "[listingId]": "identifier", ...ORG, "--capability": "identifier", "--daily-cap": "identifier" },
	"domain add": { "<domain>": "identifier", "--handle": "identifier", ...ORG },
	"domain list": ORG,
	"domain verify": { "<domainId>": "identifier", "--timeout": "identifier", ...ORG },
	"domain remove": { "<domainId>": "identifier", ...ORG },
	search: {
		"[query]": "freeText",
		...ORG,
		"--capability": "identifier",
		"--category": "identifier",
		"--limit": "identifier",
		"--offset": "identifier",
	},
	"peers list": { "--team": "identifier", ...ORG },
	"peers allowlist": { "--team": "identifier", "--npub": "publicKey", "--name": "freeText", ...ORG },
	"peers accept": PEER_DECISION,
	"peers refuse": PEER_DECISION,
	"peers ignore": PEER_DECISION,
	"peers block": PEER_DECISION,
	serve: {
		"--allow": "publicKey",
		"--capability": "identifier",
		"--handler": LOCATION,
		"--poll-interval": "identifier",
		"--max-auto-depth": "identifier",
		"--reply-text": MESSAGE,
	},
	gateway: { "--host": "identifier", "--port": "identifier", "--poll-interval": "identifier" },
	"gateway key new": { "--label": "freeText" },
	"gateway key revoke": { "<id>": "identifier" },
	inbox: { "--wait": "identifier", "--thread": THREAD_ID },
	wait: { "--timeout": "identifier" },
	"held allow": HELD,
	"held ignore": HELD,
	"held block": HELD,
	thread: { "<contextId>": THREAD_ID },
	send: { "<peer>": "publicKey", "<message>": MESSAGE, "--subject": MESSAGE, "--context-id": THREAD_ID },
	ui: {
		"--port": "identifier",
		"--compose": LOCATION,
		"--drafts": LOCATION,
		"--idle": "identifier",
		"--dev-store": LOCATION,
	},
	request: { "<peer>": "publicKey", "<capability>": "identifier", "--payload": MESSAGE, "--timeout": "identifier" },
	card: { "<peer>": "publicKey", "--relay": LOCATION },
	relay: { "--port": "identifier", "--tls-port": "identifier" },
	"tailscale enable": {
		"--auth-key": "secret",
		"--auth-key-stdin": "secret",
		"--oauth-url": LOCATION,
		"--oauth-client-id": "identifier",
		"--oauth-client-secret": "secret",
		"--oauth-client-secret-stdin": "secret",
		"--oauth-scope": "identifier",
		"--oauth-tailnet": "identifier",
		"--oauth-token-auth": "identifier",
		"--oauth-api-base-url": LOCATION,
		"--tag": "identifier",
		"--hostname": "identifier",
		"--state-dir": LOCATION,
	},
	"tailscale up": { "--auth-key": "secret", "--auth-key-stdin": "secret", "--hostname": "identifier", "--state-dir": LOCATION },
};

/**
 * The environment variables the CLI reads. Only these are looked at, and each one is
 * looked at on every command, whether or not that command reads it: a key in one of them
 * would otherwise sit there until a command that does read it prints it. Because of that, a
 * run of 64 hex digits is let through the variables that hold a folder, a file or a URL (see
 * {@link LOCATION}): refusing a hash in a folder name would stop every command. The others hold
 * an id, a name or a switch, as their options do, and refuse it.
 */
export const ENV_SLOTS: Record<string, SlotSpec> = {
	AGX_HOME: LOCATION,
	AGX_PROFILE: { kind: "identifier", profileName: true },
	AGX_API_URL: LOCATION,
	AGX_API_KEY: "secret",
	AGX_ORG: "identifier",
	AGX_RELAY: LOCATION,
	AGX_GATEWAY_KEY: "secret",
	AGX_TAILSCALE: "identifier",
	AGX_TAILSCALE_AUTH_KEY: "secret",
	TS_AUTHKEY: "secret",
	AGX_TAILSCALE_OAUTH_CLIENT_SECRET: "secret",
	AGX_TAILSCALE_OAUTH_URL: LOCATION,
	AGX_TAILSCALE_OAUTH_CLIENT_ID: "identifier",
	AGX_TAILSCALE_OAUTH_SCOPE: "identifier",
	AGX_TAILSCALE_OAUTH_TOKEN_AUTH: "identifier",
	AGX_TAILSCALE_OAUTH_API_BASE_URL: LOCATION,
	AGX_TAILSCALE_TAILNET: "identifier",
	AGX_TAILSCALE_TAGS: "identifier",
	AGX_TAILSCALE_HOSTNAME: "identifier",
	AGX_TAILSCALE_STATE_DIR: LOCATION,
	// Read by the launcher package, which the CLI starts with its standard error passed straight through.
	AGX_TAILSCALE_BINARY: LOCATION,
	AGX_DEBUG: "identifier",
	AGX_NO_BROWSER: "identifier",
	AGX_UI_DEV_STORE: "identifier",
	AGX_ELLADEX_URL: LOCATION,
};
