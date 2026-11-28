import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SLOTS } from "../lib/input-slots.js";
import { buildProgram } from "../program.js";
import { walkProgram } from "../test/canary-kit.js";
import { agx, sandbox } from "../test/helpers.js";

// A secret key typed on the command line stays in the shell's history and in the process list. The
// help of every command that takes one leads with the way that keeps it off the command line
// (`--stdin`, or for the identity `--from-env`), says why in one sentence, and never shows a key as
// a positional argument. The help of every other command is as it was. The help is read the way a
// pipe reads it (80 columns, no colour).

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

const WHY = "a key typed on the command line stays in the shell's history and in the process list";

/** What `agx <command> --help` prints for the commands that take a secret key, and for the list that names them. */
const CHANGED: Array<[string, string]> = [
	["identity import",
		"Usage: agx identity import --stdin [--force]\n       agx identity import --from-env <name> [--force]\n\nimport a secret key (an nsec or 64 hex digits). Pipe it in with --stdin or read\nit from an environment variable with --from-env: a key typed on the command line\nstays in the shell's history and in the process list.\n\nOptions:\n  --stdin            read the secret from stdin\n  --from-env <name>  read the secret from the environment variable NAME (agx\n                     does not clear it)\n  --force            replace an existing identity\n  -h, --help         display help for command\n",
	],
	["identity",
		"Usage: agx identity [options] [command]\n\nmanage this agent's keypair and peer allowlist\n\nOptions:\n  -h, --help                  display help for command\n\nCommands:\n  new [options]               generate a keypair and store it in the profile\n  show                        print this agent's npub\n  import [options]            import a secret key (pipe it in with --stdin)\n  export [options]            print the secret key\n  sign <nonce>                sign an index key-possession challenge and print\n                              the signed event\n  allow [options] [peers...]  allow peers to invoke this agent's capabilities\n  deny <peers...>             remove peers from the allowlist\n  register [options]          prove possession of this key and create an\n                              external listing in the index\n  help [command]              display help for command\n",
	],
	["config set",
		"Usage: agx config set apiKey --stdin\n       agx config set [options] <key> [value]\n\nset apiBaseUrl | apiKey | orgSlug | relays | org | nip05. Pipe an apiKey in with\n--stdin: a key typed on the command line stays in the shell's history and in the\nprocess list.\n\nOptions:\n  --stdin     read the value from stdin (one line)\n  -h, --help  display help for command\n",
	],
	["tailscale enable",
		"Usage: agx tailscale enable [--auth-key-stdin | --oauth-client-secret-stdin] [options]\n\nconfigure Tailscale auth for this profile and verify the proxy. Pass a key with\n--auth-key-stdin or a client secret with --oauth-client-secret-stdin: a key\ntyped on the command line stays in the shell's history and in the process list.\n\nOptions:\n  --auth-key-stdin                read the Tailscale auth key from stdin\n  --auth-key <key>                Tailscale auth key (prefer --auth-key-stdin)\n  --oauth-url <url>               OAuth token URL of the authentication service\n  --oauth-client-id <id>          OAuth client id\n  --oauth-client-secret-stdin     read the OAuth client secret from stdin\n  --oauth-client-secret <secret>  OAuth client secret (prefer stdin)\n  --oauth-scope <scope>           OAuth scope to request\n  --oauth-tailnet <tailnet>       tailnet for a minted key (default -)\n  --oauth-token-auth <method>     how to present the client secret (choices:\n                                  \"basic\", \"post\")\n  --oauth-api-base-url <url>      Tailscale API base for minting a key\n  --tag <tag...>                  tag for a minted key (repeatable, default\n                                  tag:agx-agent)\n  --hostname <name>               hostname to request from Tailscale\n  --state-dir <path>              persistent tsnet state dir (default: fresh dir\n                                  under AGX_HOME per run)\n  --no-up                         store the configuration without starting a\n                                  proxy\n  -v, --verbose                   log transport activity\n  -h, --help                      display help for command\n",
	],
	["tailscale up",
		"Usage: agx tailscale up [--auth-key-stdin] [options]\n\nverify the profile can start its bundled Tailscale proxy. Pass a one-off key\nwith --auth-key-stdin: a key typed on the command line stays in the shell's\nhistory and in the process list.\n\nOptions:\n  --auth-key-stdin    read a one-off Tailscale auth key from stdin\n  --auth-key <key>    one-off Tailscale auth key (not stored)\n  --hostname <name>   hostname to request from Tailscale\n  --state-dir <path>  persistent tsnet state dir (default: fresh dir under\n                      AGX_HOME per run)\n  -v, --verbose       log transport activity\n  -h, --help          display help for command\n",
	],
];

/** Commands next to them whose help must not move: the lists that show the changed ones and two siblings. */
const UNCHANGED: Array<[string, string]> = [
	["config",
		"Usage: agx config [options] [command]\n\nmanage profiles\n\nOptions:\n  -h, --help                   display help for command\n\nCommands:\n  show [options]               show the active profile (never prints an API key)\n  set [options] <key> [value]  set apiBaseUrl | apiKey | orgSlug | relays | org\n                               | nip05 (apiKey: pipe it with --stdin)\n  use <profile>                switch the active profile (creating it if needed)\n  list                         list profiles\n  path                         print the config file path\n  help [command]               display help for command\n",
	],
	["tailscale",
		"Usage: agx tailscale [options] [command]\n\nopt in to Tailscale routing (bundled tsnet SOCKS5 proxy; transport stays Nostr)\n\nOptions:\n  -h, --help         display help for command\n\nCommands:\n  enable [options]   configure Tailscale auth for this profile and verify the\n                     proxy\n  up [options]       verify the profile can start its bundled Tailscale proxy\n  status             show the opt-in, auth readiness and proxy settings (never a\n                     key)\n  disable [options]  stop starting a Tailscale proxy for this profile\n  help [command]     display help for command\n",
	],
	["identity new",
		"Usage: agx identity new [options]\n\ngenerate a keypair and store it in the profile\n\nOptions:\n  --force     replace an existing identity\n  -h, --help  display help for command\n",
	],
	["config show",
		"Usage: agx config show [options]\n\nshow the active profile (never prints an API key)\n\nOptions:\n  -h, --help  display help for command\n",
	],
	["tailscale status",
		"Usage: agx tailscale status [options]\n\nshow the opt-in, auth readiness and proxy settings (never a key)\n\nOptions:\n  -h, --help  display help for command\n",
	],
];

async function helpOf(command: string): Promise<string> {
	const run = await agx(...command.split(" "), "--help");
	expect(run.code).toBe(0);
	expect(run.stderr).toBe("");
	return run.stdout;
}

describe("the help of a command that takes a secret key", () => {
	it.each(CHANGED)("%s: is exactly this", async (command, expected) => {
		expect(await helpOf(command)).toBe(expected);
	});

	it.each(CHANGED.filter(([command]) => command !== "identity"))("%s: says in one sentence why a key does not belong on the command line", async (command) => {
		const help = (await helpOf(command)).replace(/\s+/g, " ");
		expect(help.split(WHY).length - 1).toBe(1);
	});

	it("identity import: the usage line starts with --stdin, then --from-env, and the positional is not shown", async () => {
		const help = await helpOf("identity import");
		const usage = help.slice(0, help.indexOf("\n\n"));
		expect(usage.split("\n")[0]).toBe("Usage: agx identity import --stdin [--force]");
		expect(usage.split("\n")[1]).toContain("--from-env");
		expect(usage).not.toContain("[secret]");
		expect(usage).not.toContain("[options]");
	});

	it("the other commands that take a secret lead their usage line with the flag that reads it from standard input", async () => {
		expect((await helpOf("config set")).split("\n")[0]).toBe("Usage: agx config set apiKey --stdin");
		expect((await helpOf("tailscale enable")).split("\n")[0]).toMatch(/^Usage: agx tailscale enable \[--auth-key-stdin \| --oauth-client-secret-stdin\] /);
		expect((await helpOf("tailscale up")).split("\n")[0]).toMatch(/^Usage: agx tailscale up \[--auth-key-stdin\] /);
	});

	it("lists a flag that reads a secret from standard input before the option that takes the same secret as a value, in every command", async () => {
		const found: string[] = [];
		for (const node of walkProgram(buildProgram())) {
			const stdinFlags = node.slots.filter((slot) => slot.kind === "option" && !slot.takesValue && /-stdin$/.test(slot.name));
			for (const flag of stdinFlags) {
				const typed = node.slots.find((slot) => slot.name === flag.name.replace(/-stdin$/, ""));
				if (typed) {
					const help = await helpOf(node.label);
					found.push(node.label);
					expect(help.indexOf(`${flag.name}  `), `${node.label} ${flag.name}`).toBeGreaterThan(-1);
					expect(help.indexOf(`${flag.name}  `), `${node.label} ${flag.name}`).toBeLessThan(help.indexOf(`${typed.name} <`));
				}
			}
		}
		expect(found.sort()).toEqual(["tailscale enable", "tailscale enable", "tailscale up"]);
	});

	it("no help of any command shows an nsec1 or ncryptsec1 key, or a secret key as a positional argument", async () => {
		const secretPositionals = (label: string): string[] =>
			Object.entries(SLOTS[label] ?? {})
				.filter(([slot, spec]) => spec === "secret" && /^[<[]/.test(slot))
				.map(([slot]) => slot);
		const checked: string[] = [];
		for (const node of walkProgram(buildProgram())) {
			if (node.label === "(program)") {
				continue;
			}
			const help = await helpOf(node.label);
			checked.push(node.label);
			expect(help, node.label).not.toMatch(/nsec1|ncryptsec1/i);
			for (const slot of secretPositionals(node.label)) {
				expect(help, `${node.label} ${slot}`).not.toContain(slot);
			}
		}
		expect(checked.length).toBeGreaterThan(60);
		expect(secretPositionals("identity import")).toEqual(["[secret]"]);
	});

	it("the list of identity commands shows import without its secret and says how to give one", async () => {
		const help = await helpOf("identity");
		expect(help).toContain("  import [options]            import a secret key (pipe it in with --stdin)\n");
		expect(help).not.toContain("[secret]");
	});
});

describe("the help of every other command is as it was", () => {
	it.each(UNCHANGED)("%s: is exactly what it was", async (command, expected) => {
		expect(await helpOf(command)).toBe(expected);
	});

	it("every command but the four that take a secret keeps the usage line the parser makes for it", async () => {
		const own = new Set(CHANGED.map(([command]) => command));
		let checked = 0;
		for (const node of walkProgram(buildProgram())) {
			if (node.label === "(program)" || own.has(node.label)) {
				continue;
			}
			const first = (await helpOf(node.label)).split("\n")[0];
			expect(first, node.label).toMatch(new RegExp(`^Usage: agx ${node.label} \\[options\\]( \\[command\\])?( [<[][A-Za-z.]+[>\\]])*$`));
			checked += 1;
		}
		expect(checked).toBeGreaterThan(60);
	});
});
