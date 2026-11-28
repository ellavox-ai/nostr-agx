import { existsSync } from "node:fs";
import { holdsHexKey, holdsHexRun, holdsSecretKey, normalizePubkey } from "@nostr-agx/nostr";
import type { Command } from "commander";
import { loadConfig, resolveProfileName } from "./config.js";
import { usageError } from "./errors.js";
import { identityExists, loadIdentityFile } from "./identity.js";
import { ENV_SLOTS, SLOTS, type SlotPolicy, type SlotRule, type SlotSpec, type SlotTable } from "./input-slots.js";
import { notice } from "./output.js";
import { profileDir } from "./paths.js";

/**
 * The check every typed value goes through, once, after the parser has read the command line
 * and before any command runs. A secret key typed into a slot that is not a secret slot is
 * refused here, so it never reaches a file name, a file, a request or a child process.
 * The message names the slot and never repeats the value.
 */

/** A profile name is one short folder name. 32 is above every name in use (the longest is 21) and too short to hold a key's 64 digits. */
export const PROFILE_NAME_MAX = 32;

const PROFILE_NAME = new RegExp(`^[A-Za-z0-9._-]{1,${PROFILE_NAME_MAX}}$`);

/** Letters, digits, `-`, `_` and `.`, at most {@link PROFILE_NAME_MAX} of them, and not `.` or `..`. */
export function isValidProfileName(name: string): boolean {
	return PROFILE_NAME.test(name) && name !== "." && name !== "..";
}

/**
 * A profile that is already stored under a name the rule does not allow (an older build took any
 * name): its folder is there, or its name is in config.json. It can still be named, so it is not
 * lost once it is no longer the current one. A name that is not one folder name (a slash, a
 * backslash, `.` or `..`) is never one, and a new profile needs a name the rule allows.
 */
function isStoredProfileName(name: string): boolean {
	if (name === "" || name === "." || name === ".." || /[/\\]/.test(name) || name.includes("\0")) {
		return false;
	}
	try {
		return existsSync(profileDir(name)) || Object.hasOwn(loadConfig().profiles, name);
	} catch {
		return false;
	}
}

/** The name of an environment variable: letters, digits and "_", not starting with a digit. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The longest variable name accepted. A longer text is not shown back: a key typed as a name, one character off, is longer. */
const ENV_NAME_MAX = 40;

/** A name holding a run of this many hex digits is not accepted, so a key one or two digits short cannot be repeated back as a name (the same length the parser's own errors hide). */
const ENV_NAME_HEX_DIGITS = 56;

/** Letters, digits and "_", not starting with a digit, at most 40 characters, and no run of 56 or more hex digits. */
export function isValidEnvName(name: string): boolean {
	return name.length <= ENV_NAME_MAX && ENV_NAME.test(name) && !holdsHexRun(name, ENV_NAME_HEX_DIGITS);
}

const KEY_SHAPE = "holds a secret key (nsec1… or ncryptsec1…)";
const HEX_RUN = "holds a 64-character hex string, which may be a secret key";
const OWN_KEY = "holds this profile's own secret key";

const KEY_REMEDIATION = "A secret key belongs only in `agx identity import` (pipe it in with --stdin). Check what each command takes with `agx --help`.";
const NAME_REMEDIATION = "Use a short name, for example:  agx -p work identity new";
const ENV_NAME_REMEDIATION = "Name the variable that holds the key, for example:  agx identity import --from-env AGENT_KEY";

export interface InputCheckOptions {
	table?: SlotTable;
	envTable?: Record<string, SlotSpec>;
	env?: NodeJS.ProcessEnv;
}

/** What a command was given on its command line, by slot name: the text, or a list of texts for a slot that repeats. Other values (flags, numbers) are left out. */
function typedValues(command: Command): Record<string, string | string[]> {
	const values: Record<string, string | string[]> = {};
	const texts = (value: unknown, repeats: boolean): string | string[] | undefined => {
		const list = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
		return repeats ? list : list[0];
	};
	const keep = (slot: string, value: string | string[] | undefined): void => {
		if (value !== undefined) {
			values[slot] = value;
		}
	};
	command.registeredArguments.forEach((argument, index) => {
		const slot = `${argument.name()}${argument.variadic ? "..." : ""}`;
		keep(argument.required ? `<${slot}>` : `[${slot}]`, texts(command.processedArgs[index], argument.variadic));
	});
	for (const option of command.options) {
		const source = command.getOptionValueSource(option.attributeName());
		if (source !== undefined && source !== "default") {
			keep(option.long ?? option.short ?? option.flags, texts(command.getOptionValue(option.attributeName()), option.variadic));
		}
	}
	return values;
}

function ruleOf(spec: SlotSpec | undefined, others: Record<string, unknown>): SlotRule {
	const resolved = typeof spec === "function" ? spec(others) : spec;
	return typeof resolved === "string" ? { kind: resolved } : (resolved ?? { kind: "freeText" });
}

/** The secret key of the profile the command would use, as lower-case hex; null when there is none to read. */
function ownSecretKey(profileFlag: unknown): string | null {
	try {
		const name = resolveProfileName(typeof profileFlag === "string" ? profileFlag : undefined);
		return (isValidProfileName(name) || isStoredProfileName(name)) && identityExists(name)
			? loadIdentityFile(name, { allowInsecurePerms: true }).secretKeyHex.toLowerCase()
			: null;
	} catch {
		return null;
	}
}

/**
 * Why `value` does not belong in a slot of this rule, or null. The own key is only looked up
 * when the value could be it: a 64-digit run, or (in a public key slot) a peer written as an
 * npub, which can carry the same 32 bytes.
 */
function whatIsWrong(value: string, rule: SlotRule, own: () => string | null): string | null {
	if (holdsSecretKey(value)) {
		return KEY_SHAPE;
	}
	const hasRun = holdsHexKey(value);
	if (rule.kind === "identifier" && !rule.hexOk && hasRun) {
		return HEX_RUN;
	}
	const asPeer = rule.kind === "publicKey" ? normalizePubkey(value.trim()) : null;
	if (hasRun || asPeer !== null) {
		const key = own();
		if (key !== null && (asPeer?.toLowerCase() === key || holdsHexKey(value, key))) {
			return OWN_KEY;
		}
	}
	return null;
}

function refuseOrWarn(label: string, reason: string, policy: SlotPolicy): void {
	if (policy === "warn") {
		notice(`${label} ${reason}. It is used as typed and is not shown here.`);
	} else if (policy === "refuse") {
		throw usageError(`${label} ${reason}, so it was not used and is not shown here.`, KEY_REMEDIATION);
	}
}

function checkValue(label: string, value: string, rule: SlotRule, own: () => string | null): void {
	if (rule.kind === "secret") {
		return;
	}
	const policy = rule.policy ?? "refuse";
	const reason = policy === "allow" ? null : whatIsWrong(value, rule, own);
	if (reason !== null) {
		refuseOrWarn(label, reason, policy);
	}
	if (rule.profileName && !isValidProfileName(value) && !isStoredProfileName(value)) {
		throw usageError(
			`${label} is not a valid profile name (1 to ${PROFILE_NAME_MAX} letters, digits, "-", "_" or "."; not "." or ".."), so it was not used and is not shown here.`,
			NAME_REMEDIATION,
		);
	}
	if (rule.envName && !isValidEnvName(value)) {
		throw usageError(
			`${label} is not a valid environment variable name (letters, digits and "_", not starting with a digit), so it was not used and is not shown here.`,
			ENV_NAME_REMEDIATION,
		);
	}
}

/**
 * Look at every value typed for the command about to run (its own arguments and options and
 * those of the commands above it, such as `--profile`) and at the environment variables of
 * the table. Throws a usage error (exit 2) for the first one that does not belong; a slot
 * whose rule says `warn` prints one line instead, and `allow` is let through.
 */
export function checkInputs(action: Command, options: InputCheckOptions = {}): void {
	const { table = SLOTS, envTable = ENV_SLOTS, env = process.env } = options;
	const chain: Command[] = [];
	for (let command: Command | null = action; command; command = command.parent) {
		chain.unshift(command);
	}
	const profileFlag = (chain[0] as Command).opts().profile;
	let own: string | null | undefined;
	const ownKey = (): string | null => {
		if (own === undefined) {
			own = ownSecretKey(profileFlag);
		}
		return own;
	};

	for (const [name, spec] of Object.entries(envTable)) {
		const value = env[name];
		const rule = ruleOf(spec, {});
		// A profile name typed with --profile wins over the variable, so it is never used as a name: only the name rule is skipped.
		const used = rule.profileName && typeof profileFlag === "string" ? { ...rule, profileName: false } : rule;
		if (value !== undefined) {
			checkValue(`The environment variable ${name}`, value, used, ownKey);
		}
	}
	chain.forEach((command, depth) => {
		const label = depth === 0 ? "(program)" : chain.slice(1, depth + 1).map((step) => step.name()).join(" ");
		const suffix = depth === 0 ? "" : ` (agx ${label})`;
		const values = typedValues(command);
		for (const [slot, given] of Object.entries(values)) {
			const rule = ruleOf(table[label]?.[slot], values);
			const named = slot.startsWith("-") ? `The value of \`${slot}\`${suffix}` : `The \`${slot}\` argument${suffix}`;
			for (const text of Array.isArray(given) ? given : [given]) {
				checkValue(named, text, rule, ownKey);
			}
		}
	});
}
