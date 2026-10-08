import { Command, Option } from "commander";
import kleur from "kleur";
import { cardCommand } from "../commands/card.js";
import {
	configListCommand,
	configPathCommand,
	configSetCommand,
	configShowCommand,
	configUseCommand,
} from "../commands/config.js";
import { doctorCommand } from "../commands/doctor.js";
import {
	domainAddCommand,
	domainListCommand,
	domainRemoveCommand,
	domainVerifyCommand,
} from "../commands/domain.js";
import {
	identityAllowCommand,
	identityAllowListCommand,
	identityDenyCommand,
	identityExportCommand,
	identityImportCommand,
	identityNewCommand,
	identityShowCommand,
	identitySignCommand,
} from "../commands/identity.js";
import {
	listingCreateCommand,
	listingDeleteCommand,
	listingDelistCommand,
	listingGetCommand,
	listingListCommand,
	listingPublishCommand,
	listingSetPolicyCommand,
	listingSetVisibilityCommand,
} from "../commands/listing.js";
import {
	peersAllowlistCommand,
	peersDecideCommand,
	peersListCommand,
} from "../commands/peers.js";
import { registerCommand } from "../commands/register.js";
import { relayCommand } from "../commands/relay.js";
import { searchCommand } from "../commands/search.js";
import { requestCommand, sendCommand } from "../commands/send.js";
import { heldDecideCommand, heldListCommand } from "../commands/held.js";
import { inboxCommand } from "../commands/inbox.js";
import { uiCommand } from "../commands/ui.js";
import { serveCommand } from "../commands/serve.js";
import { threadCommand, threadsCommand } from "../commands/threads.js";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { setColor, setJsonMode } from "../lib/output.js";
import { AGX_CLI_VERSION } from "../lib/version.js";

/**
 * The category slugs the Agent Index accepts — a closed list, so a value off it
 * is a 400 rather than an empty result. Spelled here because the CLI does not
 * depend on any index implementation; keep it in step with the index's own list.
 */
const CATEGORY_HELP =
	"category slug (repeatable): finance, sales, marketing, customer-support, hr, legal, operations, engineering, devops, data, research, productivity, communication, commerce, security";

const program = new Command();

program
	.name("agx")
	.description(
		"NIP-AGX agent CLI — hold an identity, register it in an agent index, and run a real off-platform agent over Nostr.",
	)
	.version(AGX_CLI_VERSION)
	.option("-p, --profile <name>", "profile to use (env: AGX_PROFILE)")
	.option("--json", "emit machine-readable JSON")
	.option("--no-color", "disable coloured output")
	.hook("preAction", (thisCommand) => {
		const opts = thisCommand.opts();
		setJsonMode(Boolean(opts.json));
		// Only ever turn colour OFF. kleur already disables itself when stdout is
		// not a TTY (and honours NO_COLOR / FORCE_COLOR); forcing it on here would
		// write ANSI escapes into every pipe, log file and Monitor stream.
		if (opts.color === false) {
			setColor(false);
		}
	});

/**
 * Merge the root command's global options (`--profile`, `--json`, `--no-color`)
 * into a subcommand's own options. Subcommand options win, so a command-level
 * flag of the same name always overrides the global.
 */
function withGlobals<T extends object>(options: T): T {
	return { ...program.opts<Record<string, unknown>>(), ...options };
}

// ---------------------------------------------------------------- config

const config = program.command("config").description("manage profiles");
config
	.command("show")
	.description("show the active profile")
	.option("--reveal", "print the API key in full")
	.action((options) => configShowCommand(withGlobals(options)));
config
	.command("set <key> <value>")
	.description("set apiBaseUrl | apiKey | orgSlug | relays | org | nip05")
	.action((key, value, options) =>
		configSetCommand(key, value, withGlobals(options)),
	);
config
	.command("use <profile>")
	.description("switch the active profile (creating it if needed)")
	.action((name) => configUseCommand(name));
config.command("list").description("list profiles").action(configListCommand);
config
	.command("path")
	.description("print the config file path")
	.action(configPathCommand);

// -------------------------------------------------------------- identity

const identity = program
	.command("identity")
	.description("manage this agent's keypair and peer allowlist");
identity
	.command("new")
	.description("generate a keypair and store it in the profile")
	.option("--force", "replace an existing identity")
	.action((options) => identityNewCommand(withGlobals(options)));
identity
	.command("show")
	.description("print this agent's npub")
	.action((options) => identityShowCommand(withGlobals(options)));
identity
	.command("import [secret]")
	.description("import an nsec1… or 64-char hex secret key")
	.option("--stdin", "read the secret from stdin")
	.option("--force", "replace an existing identity")
	.action((secret, options) =>
		identityImportCommand(secret, withGlobals(options)),
	);
identity
	.command("export")
	.description("print the secret key")
	.option("--hex", "print hex instead of nsec")
	.option("--yes", "confirm printing a secret to a terminal")
	.action((options) => identityExportCommand(withGlobals(options)));
identity
	.command("sign <nonce>")
	.description(
		"sign an index key-possession challenge and print the signed event",
	)
	.action((nonce: string, options) =>
		identitySignCommand(nonce, withGlobals(options)),
	);
identity
	.command("allow [peers...]")
	.description("allow peers to invoke this agent's capabilities")
	.option("--list", "show the current allowlist")
	.action((peers: string[], options) => {
		const merged = withGlobals(options);
		if (options.list || peers.length === 0) {
			identityAllowListCommand(merged);
			return;
		}
		identityAllowCommand(peers, merged);
	});
identity
	.command("deny <peers...>")
	.description("remove peers from the allowlist")
	.action((peers: string[], options) =>
		identityDenyCommand(peers, withGlobals(options)),
	);

// -------------------------------------------------------------- register

/**
 * The registration flow is exposed twice on purpose: `agx register` is the short
 * form, `agx identity register` reads naturally next to the other identity
 * commands (and is the spelling the walkthrough uses). Same action, one
 * definition.
 */
function addRegisterOptions(command: Command): Command {
	return command
		.description(
			"prove possession of this key and create an external listing in the index",
		)
		.requiredOption(
			"--slug <slug>",
			"listing slug (lowercase, dash separated)",
		)
		.option(
			"--display-name <name>",
			"human-readable name (defaults from the slug)",
		)
		.option("--org <slug>", "organization slug (defaults to the profile)")
		.option(
			"--capability <key...>",
			"capability this agent handles (repeatable, e.g. invoice.review)",
		)
		.option("--summary <text>", "one-line summary")
		.option("--description <text>", "long description")
		.option("--use-cases <text>", "use cases")
		.option("--category <name...>", CATEGORY_HELP)
		.option("--tag <name...>", "tag (repeatable)")
		.option("--runtime <name>", "runtime label")
		.addOption(
			new Option("--visibility <level>", "listing visibility").choices([
				"private",
				"unlisted",
				"public",
			]),
		)
		.option("--handle <name>", "NIP-05 handle name (requires --domain-id)")
		.option("--domain-id <id>", "verified domain id for the handle")
		.option(
			"--skip-proof",
			"skip the proof step to demonstrate the 403 it produces",
		)
		.action((options) => registerCommand(withGlobals(options)));
}

addRegisterOptions(program.command("register"));
addRegisterOptions(identity.command("register"));

// --------------------------------------------------------------- listing

const listing = program.command("listing").description("manage index listings");
listing
	.command("create")
	.description(
		"create a listing for a team (--team) or an external key (--pubkey)",
	)
	.requiredOption("--slug <slug>", "listing slug (lowercase, dash separated)")
	.option("--team <teamId>", "list a team the index already holds a key for")
	.option(
		"--pubkey <npub>",
		"list an external key (requires a recorded proof)",
	)
	.option(
		"--display-name <name>",
		"human-readable name (defaults from the slug)",
	)
	.option("--capability <key...>", "capability (repeatable)")
	.option("--summary <text>")
	.option("--description <text>")
	.option("--category <name...>", CATEGORY_HELP)
	.option("--tag <name...>")
	.option("--runtime <name>")
	.addOption(
		new Option("--visibility <level>", "listing visibility").choices([
			"private",
			"unlisted",
			"public",
		]),
	)
	.option("--handle <name>", "NIP-05 handle name (requires --domain-id)")
	.option("--domain-id <id>", "verified domain id for the handle")
	.option(
		"--relay <url...>",
		"--pubkey only: relay the external agent is reachable on (repeatable; defaults to this profile's relays only when --pubkey is this profile's own key)",
	)
	.option("--org <slug>")
	.action((options) => listingCreateCommand(withGlobals(options)));
listing
	.command("list")
	.description("list this organization's own listings")
	.option("--org <slug>")
	.option("--limit <n>")
	.action((options) => listingListCommand(withGlobals(options)));
listing
	.command("get [listingId]")
	.description("show a listing (defaults to this profile's)")
	.option("--org <slug>")
	.action((id, options) => listingGetCommand(id, withGlobals(options)));
listing
	.command("publish [listingId]")
	.description("publish a listing to the directory")
	.option("--org <slug>")
	.addOption(
		new Option(
			"--visibility <level>",
			"set visibility before publishing",
		).choices(["private", "unlisted", "public"]),
	)
	.action((id, options) => listingPublishCommand(id, withGlobals(options)));
listing
	.command("set-visibility <level> [listingId]")
	.description("set a listing's visibility (public | unlisted | private)")
	.option("--org <slug>")
	.action((level, id, options) =>
		listingSetVisibilityCommand(level, id, withGlobals(options)),
	);
listing
	.command("delist [listingId]")
	.description("remove a listing from the directory")
	.option("--org <slug>")
	.action((id, options) => listingDelistCommand(id, withGlobals(options)));
listing
	.command("delete [listingId]")
	.description("delete a listing permanently")
	.option("--org <slug>")
	.option("--yes", "confirm")
	.action((id, options) => listingDeleteCommand(id, withGlobals(options)));
listing
	.command("set-policy [listingId]")
	.description("configure first-contact auto-allow")
	.option("--org <slug>")
	.option("--auto-allow", "enable auto-allow")
	.option("--no-auto-allow", "disable auto-allow")
	.option("--capability <key...>", "capabilities that qualify for auto-allow")
	.option("--daily-cap <n>", "maximum auto-allowed contacts per day")
	.action((id, options) => listingSetPolicyCommand(id, withGlobals(options)));

// ---------------------------------------------------------------- domain

const domain = program
	.command("domain")
	.description("claim and verify NIP-05 domains");
domain
	.command("add <domain>")
	.description("claim a domain for this organization")
	.option("--org <slug>")
	.action((d, options) => domainAddCommand(d, withGlobals(options)));
domain
	.command("list")
	.description("list claimed domains")
	.option("--org <slug>")
	.action((options) => domainListCommand(withGlobals(options)));
domain
	.command("verify <domainId>")
	.description("run NIP-05 verification for a domain")
	.option("--org <slug>")
	.action((id, options) => domainVerifyCommand(id, withGlobals(options)));
domain
	.command("remove <domainId>")
	.description("release a domain")
	.option("--org <slug>")
	.option("--yes", "confirm")
	.action((id, options) => domainRemoveCommand(id, withGlobals(options)));

// ---------------------------------------------------------------- search

program
	.command("search [query]")
	.description("search the agent index")
	.option("--org <slug>")
	.option("--capability <key...>", "require a capability (repeatable)")
	.option("--category <name...>", `filter by ${CATEGORY_HELP}`)
	.option("--verified-only", "only NIP-05 verified listings")
	.option("--mine", "this organization's own listings, at any status")
	.option("--limit <n>")
	.option("--offset <n>")
	.action((query, options) => searchCommand(query, withGlobals(options)));

// ----------------------------------------------------------------- peers

const peers = program
	.command("peers")
	.description("manage a team's exchange trust decisions");
peers
	.command("list")
	.description("list a team's exchange peers")
	.requiredOption("--team <teamId>")
	.option("--org <slug>")
	.action((options) => peersListCommand(withGlobals(options)));
peers
	.command("allowlist")
	.description("approve a recipient so the team may message it")
	.requiredOption("--team <teamId>")
	.requiredOption("--npub <identity>")
	.option("--name <displayName>")
	.option("--org <slug>")
	.action((options) => peersAllowlistCommand(withGlobals(options)));
for (const action of ["accept", "refuse", "ignore", "block"] as const) {
	peers
		.command(action)
		.description(`${action} a pending peer`)
		.requiredOption("--team <teamId>")
		.requiredOption("--peer <peerId>")
		.option("--reason <text>", "required when refusing")
		.option("--org <slug>")
		.action((options) => peersDecideCommand(action, withGlobals(options)));
}

// ------------------------------------------------------------ agent mode

program
	.command("serve")
	.description("run as an agent: poll relays, decrypt, dispatch, reply")
	.option("--allow <npub...>", "allow these peers for this session only")
	.option(
		"--allow-all",
		"accept task requests from ANY peer (explicit opt-out of default-deny)",
	)
	.option("--advertise", "publish an Agent Card and relay list (unencrypted)")
	.option("--capability <key...>", "capabilities to handle")
	.option(
		"--handler <file>",
		"JS module default-exporting { capability: handler } — the runtime binding",
	)
	.option("--poll-interval <ms>", "poll interval in milliseconds", "3000")
	.option(
		"--no-reply",
		"never auto-reply to a plain message (typed task requests are still answered unless --no-tasks)",
	)
	.option(
		"--no-tasks",
		"serve no capability at all (not even agx.ping): a typed task request gets no receipt and no result, and prints like any other message. Cannot be combined with --capability, --handler, --advertise or --allow-all",
	)
	.option(
		"--reply-any",
		"reply to peers that are not on the allowlist (does NOT lift the automated-reply depth ceiling)",
	)
	.option(
		"--max-auto-depth <n>",
		"stop auto-replying once a conversation reaches this automated-reply depth",
		"4",
	)
	.option("--reply-text <text>", "fixed reply body")
	.option(
		"--allowed-only",
		"print a plain message's subject and text only when the sender is on the allowlist; others print one HOLD line with just their npub. Affects printing only: --reply-any still replies and --allow-all still runs their tasks (payload not printed)",
	)
	.option(
		"--full-ids",
		"print the full sender npub and contextId on RECV lines, so a reader can reply with `agx send --context-id <id> -- <npub> <message>`",
	)
	.option("--once", "run a single poll and exit")
	.option("--reset-cursor", "re-read the inbox from the beginning")
	.option("-v, --verbose", "log transport activity")
	.action((options) => serveCommand(withGlobals(options)));

program
	.command("inbox")
	.description("pull new messages once and exit: never replies, never runs tasks")
	.option("--wait <seconds>", "bound the pull (default 10)")
	.option("--unread", "list every unread message, not only the new ones")
	.option("--thread <contextId>", "list one thread")
	.option("--full-ids", "print full npubs and ids")
	.option("--summary", "counts only, no peer text (safe for a hook)")
	.option("-v, --verbose", "log transport activity")
	.action((options) => inboxCommand(withGlobals(options)));

const held = program
	.command("held")
	.description("decide on senders who are not on your allowlist");
held
	.command("list")
	.description("list held senders: address, count, first seen (never their text)")
	.option("--full-ids", "print full npubs")
	.action((options) => heldListCommand(withGlobals(options)));
for (const [name, text] of [
	["allow", "allow the sender and release their kept text into your inbox"],
	["ignore", "drop the sender's kept text and keep later messages out"],
	["block", "like ignore, and remove the sender from the allowlist"],
] as const) {
	held
		.command(`${name} <npub>`)
		.description(text)
		.action((npub: string, options) => heldDecideCommand(name, npub, withGlobals(options)));
}

program
	.command("threads")
	.description("list your conversations")
	.option("--full-ids", "print full npubs")
	.action((options) => threadsCommand(withGlobals(options)));

program
	.command("thread <contextId>")
	.description("show one conversation")
	.option("--mark-read", "mark the shown messages as read")
	.option("--full-ids", "print full npubs and ids")
	.action((contextId: string, options) => threadCommand(contextId, withGlobals(options)));

program
	.command("send <peer> <message>")
	.description("send a plain message to another agent")
	.option("--subject <text>")
	.option("--context-id <id>", "continue an existing thread")
	.option("-v, --verbose")
	// Commander reads a positional that starts with "-" as an option, so a
	// message like "- done" or "--help" must come after "--" (and "--" after
	// every option, since nothing past it is parsed as one).
	.addHelpText(
		"after",
		'\nA message that starts with "-" goes after "--", with every option before it:\n  agx send --context-id <id> --subject <text> -- <peer> "- migration done"',
	)
	.action((peer, message, options) =>
		sendCommand(peer, message, withGlobals(options)),
	);

program
	.command("ui")
	.description("open a local browser UI for your conversations (run it in your own terminal)")
	.option("--port <n>", "port to listen on, on 127.0.0.1 (default: a free one)")
	.option("--no-open", "print the link instead of opening a browser")
	.option("--compose <draft.json>", "load a draft {to, body, subject?, contextId?} into Compose; never sends by itself")
	.option("--drafts <dir>", "list draft files from this folder (default: ./.elladex/drafts if it exists)")
	.option("--idle <minutes>", "stop after this many minutes without activity (default 60, 0 disables)")
	.option("--dev-store <file>", "use a sample JSON store; until agx inbox ships")
	.option("-v, --verbose")
	.action((options) => uiCommand(withGlobals(options)));

program
	.command("request <peer> <capability>")
	.description("invoke a capability on another agent and await the result")
	.option("--payload <json>", "JSON payload", "{}")
	.option("--timeout <ms>", "how long to wait", "30000")
	.option("-v, --verbose")
	.action((peer, capability, options) =>
		requestCommand(peer, capability, withGlobals(options)),
	);

program
	.command("card <peer>")
	.description("read an agent's published Agent Card from the relays")
	.option("--relay <url...>", "override the relays to query")
	.option("--raw", "also print the raw signed event")
	.option(
		"--verify",
		"check the card's claimed NIP-05 against the domain itself",
	)
	.action((peer, options) => cardCommand(peer, withGlobals(options)));

program
	.command("relay")
	.description("run a local NIP-01 relay for development")
	.option("--port <n>", "port to listen on", "7447")
	.option(
		"--tls",
		"also serve wss:// on a self-signed cert, for clients that dial wss:// for real",
	)
	.option(
		"--tls-port <n>",
		"port for the wss:// listener (default: port + 1)",
	)
	.option("--regenerate-cert", "replace the stored certificate")
	.option("-v, --verbose", "log every event and request")
	.action((options) => relayCommand(withGlobals(options)));

program
	.command("doctor")
	.description("check everything this workflow depends on")
	.option("--fix-perms", "repair file permissions under ~/.agx")
	.action((options) => doctorCommand(withGlobals(options)));

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
	await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
	if (error instanceof AgxCliError) {
		console.error(`\n${kleur.red("✗")} ${error.message}`);
		if (error.remediation) {
			console.error(kleur.dim(`\n  ${error.remediation}\n`));
		}
		process.exit(error.exitCode);
	}
	console.error(
		`\n${kleur.red("✗")} ${error instanceof Error ? error.message : String(error)}`,
	);
	if (process.env.AGX_DEBUG && error instanceof Error) {
		console.error(error.stack);
	}
	process.exit(EXIT.generic);
});
