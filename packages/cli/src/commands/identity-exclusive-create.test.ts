import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../lib/errors.js";
import { createIdentity, type IdentityFile, loadIdentityFile, saveIdentity } from "../lib/identity.js";
import { ensureDir, identityPath, profileDir } from "../lib/paths.js";
import { setStdinForTests } from "../lib/stdin.js";
import { agx, sandbox } from "../test/helpers.js";

// `agx identity new` and `agx identity import` look first whether the profile
// already has an identity, and only later write the file. Two runs for the same
// profile at the same moment can both pass the look and both write. The file
// must be created only if nothing is there when it is written: the run that
// comes second is refused exactly as if it had looked a moment later, prints no
// new key, and leaves the key that is there alone. `--force` still replaces.
//
// The moment between the look and the write is made to happen in-process: both
// commands build the new identity between the two, so the stand-in below puts
// another identity on disk just before that, as a second process would. No
// check compares two keys with toBe: a failing assertion prints both sides, and
// a secret key must not end up in a test log.

const gap = vi.hoisted(() => ({
	run: undefined as undefined | (() => void),
	/** How many times a new identity was built since the last reset: an early refusal builds none. */
	built: 0,
	/** Makes the link step of an exclusive write fail, as a file system without hard links does. */
	link: undefined as undefined | NodeJS.ErrnoException,
}));

vi.mock("../lib/identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/identity.js")>();
	const inTheGap =
		<A extends unknown[], R>(build: (...args: A) => R) =>
		(...args: A): R => {
			gap.built++;
			const run = gap.run;
			gap.run = undefined;
			run?.();
			return build(...args);
		};
	return {
		...actual,
		createIdentity: inTheGap(actual.createIdentity),
		identityFromSecret: inTheGap(actual.identityFromSecret),
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		linkSync: (from: string, to: string) => {
			if (gap.link) {
				throw gap.link;
			}
			return actual.linkSync(from, to);
		},
	};
});

let box: ReturnType<typeof sandbox>;
let restoreStdin: (() => void) | undefined;
/** The identity the other process creates in the gap. */
const other = createIdentity();
/** The key being imported. */
const incoming = createIdentity();
const INCOMING_NSEC = nip19.nsecEncode(hexToBytes(incoming.secretKeyHex));
const ALREADY = 'Profile "default" already has an identity.';

beforeEach(() => {
	box = sandbox();
	gap.built = 0;
});

afterEach(() => {
	gap.run = undefined;
	gap.link = undefined;
	restoreStdin?.();
	restoreStdin = undefined;
	box.restore();
});

/** What reaches stderr for an error: colour codes dropped (kleur adds them when FORCE_COLOR is set). */
function plain(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const stored = (): IdentityFile => loadIdentityFile("default");
const files = () => readdirSync(dirname(identityPath("default"))).sort();
const mode = (path: string) => statSync(path).mode & 0o777;
const putOtherInTheGap = () => {
	gap.run = () => saveIdentity("default", other);
};

/** True when `text` holds any 64-character hex string: a secret key, or a public one. A refusal prints none. */
const holdsHex = (text: string) => /[0-9a-f]{64}/i.test(text);

describe("agx identity new, when another run creates the identity after the look", () => {
	it.each([
		["", [] as string[]],
		[" in --json mode", ["--json"]],
	])("is refused%s, prints no new key and leaves the identity that is there", async (_name, flags) => {
		putOtherInTheGap();
		const run = await agx(...flags, "identity", "new");
		expect(run.code).toBe(EXIT.config);
		expect(plain(run.stderr)).toContain(ALREADY);
		expect(plain(run.stderr)).toContain("agx identity new --profile second");
		expect(run.stdout).toBe("");
		expect(holdsHex(run.stdout + run.stderr)).toBe(false);
		expect(stored().secretKeyHex === other.secretKeyHex).toBe(true);
		expect(files()).toEqual(["identity.json"]);
		expect(mode(identityPath("default"))).toBe(0o600);
	});

	it("gives the same advice as when the identity was there at the look", async () => {
		putOtherInTheGap();
		const late = await agx("identity", "new");
		const early = await agx("identity", "new");
		expect(late.code).toBe(early.code);
		expect(plain(late.stderr)).toBe(plain(early.stderr));
	});

	it("with --force replaces it, as asked", async () => {
		putOtherInTheGap();
		const run = await agx("--json", "identity", "new", "--force");
		expect(run.code).toBe(EXIT.ok);
		expect(stored().secretKeyHex === other.secretKeyHex).toBe(false);
		expect(run.stdout).toContain(stored().publicKey);
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(files()).toEqual(["identity.json"]);
	});
});

describe("agx identity import, when another run creates the identity after the look", () => {
	function assertRefused(run: { code: number; stdout: string; stderr: string }): void {
		expect(run.code).toBe(EXIT.config);
		expect(plain(run.stderr)).toContain(ALREADY);
		expect(plain(run.stderr)).toContain("agx identity import <nsec> --profile imported");
		expect(run.stdout).toBe("");
		for (const out of [run.stdout, run.stderr]) {
			expect(out.includes(incoming.secretKeyHex)).toBe(false);
			expect(out.includes(INCOMING_NSEC)).toBe(false);
			expect(out.includes(other.secretKeyHex)).toBe(false);
		}
		expect(stored().secretKeyHex === other.secretKeyHex).toBe(true);
		expect(files()).toEqual(["identity.json"]);
		expect(mode(identityPath("default"))).toBe(0o600);
	}

	it("is refused when the key is an argument, and prints no key", async () => {
		putOtherInTheGap();
		assertRefused(await agx("identity", "import", incoming.secretKeyHex));
	});

	it("is refused when the key is piped in, and prints no key", async () => {
		restoreStdin = setStdinForTests(`${INCOMING_NSEC}\n`);
		putOtherInTheGap();
		assertRefused(await agx("identity", "import", "--stdin"));
	});

	it("is refused in --json mode too", async () => {
		putOtherInTheGap();
		assertRefused(await agx("--json", "identity", "import", incoming.secretKeyHex));
	});

	it("gives the same advice as when the identity was there at the look", async () => {
		putOtherInTheGap();
		const late = await agx("identity", "import", incoming.secretKeyHex);
		const early = await agx("identity", "import", incoming.secretKeyHex);
		expect(late.code).toBe(early.code);
		expect(plain(late.stderr)).toBe(plain(early.stderr));
	});

	it("with --force replaces it, as asked", async () => {
		putOtherInTheGap();
		const run = await agx("identity", "import", "--force", incoming.secretKeyHex);
		expect(run.code).toBe(EXIT.ok);
		expect(stored().secretKeyHex === incoming.secretKeyHex).toBe(true);
		expect(stored().source).toBe("imported");
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(files()).toEqual(["identity.json"]);
	});
});

describe("the ordinary cases of agx identity new and import keep working", () => {
	it("identity new on a profile with none creates a private identity and prints its public address", async () => {
		const run = await agx("--json", "identity", "new");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout).toContain(stored().npub);
		expect(stored().source).toBe("generated");
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(mode(dirname(identityPath("default")))).toBe(0o700);
		expect(files()).toEqual(["identity.json"]);
	});

	it("identity import on a profile with none stores the key it was given, privately", async () => {
		const run = await agx("identity", "import", incoming.secretKeyHex);
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout).toContain(incoming.npub);
		expect(stored().secretKeyHex === incoming.secretKeyHex).toBe(true);
		expect(stored().source).toBe("imported");
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(files()).toEqual(["identity.json"]);
	});

	it("a second identity new, one moment later, is refused and leaves the first", async () => {
		expect((await agx("identity", "new")).code).toBe(EXIT.ok);
		const first = stored();
		const run = await agx("identity", "new");
		expect(run.code).toBe(EXIT.config);
		expect(plain(run.stderr)).toContain(ALREADY);
		expect(run.stdout).toBe("");
		expect(stored().secretKeyHex === first.secretKeyHex).toBe(true);
		expect(files()).toEqual(["identity.json"]);
	});

	it("identity import into a profile that has an identity is refused up front, without reading the key", async () => {
		saveIdentity("default", other);
		const run = await agx("identity", "import", incoming.secretKeyHex);
		expect(run.code).toBe(EXIT.config);
		expect(plain(run.stderr)).toContain(ALREADY);
		expect(stored().secretKeyHex === other.secretKeyHex).toBe(true);
	});

	it("identity new --force replaces an identity that is there, and the new file is private", async () => {
		saveIdentity("default", other);
		const run = await agx("identity", "new", "--force");
		expect(run.code).toBe(EXIT.ok);
		expect(stored().secretKeyHex === other.secretKeyHex).toBe(false);
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(files()).toEqual(["identity.json"]);
	});

	it("identity import --force replaces an identity that is there", async () => {
		saveIdentity("default", other);
		const run = await agx("identity", "import", "--force", incoming.secretKeyHex);
		expect(run.code).toBe(EXIT.ok);
		expect(stored().secretKeyHex === incoming.secretKeyHex).toBe(true);
		expect(files()).toEqual(["identity.json"]);
	});

	it("a profile folder that cannot be created is still reported as what it is, not as an identity that exists", async () => {
		mkdirSync(join(box.home, "profiles"), { recursive: true });
		writeFileSync(join(box.home, "profiles", "blocked"), "a file where the profile folder should be");
		const run = await agx("identity", "new", "--profile", "blocked");
		expect(run.code).toBe(EXIT.generic);
		expect(run.stderr).toMatch(/EEXIST|ENOTDIR/);
		expect(plain(run.stderr)).not.toContain("already has an identity");
	});
});

describe("agx identity new, when the profile already has an identity at the look", () => {
	it("stops before it makes a key, prints nothing and does not touch the file", async () => {
		saveIdentity("default", other);
		const before = readFileSync(identityPath("default"));
		const inode = statSync(identityPath("default")).ino;
		gap.built = 0;
		const run = await agx("identity", "new");
		expect(run.code).toBe(EXIT.config);
		expect(plain(run.stderr)).toContain(ALREADY);
		expect(run.stdout).toBe("");
		expect(gap.built).toBe(0);
		expect(readFileSync(identityPath("default")).equals(before)).toBe(true);
		expect(statSync(identityPath("default")).ino).toBe(inode);
		expect(files()).toEqual(["identity.json"]);
	});

	it("import stops before it makes an identity from the key too", async () => {
		saveIdentity("default", other);
		gap.built = 0;
		const run = await agx("identity", "import", incoming.secretKeyHex);
		expect(run.code).toBe(EXIT.config);
		expect(gap.built).toBe(0);
		expect(stored().secretKeyHex === other.secretKeyHex).toBe(true);
	});
});

describe("agx identity new and import, when identity.json is a symlink", () => {
	/** A symlink named identity.json: to a file with content ("live"), or to a name with nothing behind it ("dangling"). */
	function linkIdentity(kind: "live" | "dangling"): string {
		const elsewhere = join(box.home, "elsewhere.json");
		if (kind === "live") {
			writeFileSync(elsewhere, "not an identity\n");
		}
		ensureDir(profileDir("default"));
		symlinkSync(elsewhere, identityPath("default"));
		return elsewhere;
	}

	it.each([
		["new", "live"],
		["new", "dangling"],
		["import", "live"],
		["import", "dangling"],
	] as const)("%s with a %s symlink is refused, and the symlink and what it points to are left as they were", async (command, kind) => {
		const elsewhere = linkIdentity(kind);
		const run =
			command === "new"
				? await agx("identity", "new")
				: await agx("identity", "import", incoming.secretKeyHex);
		expect(run.code).toBe(EXIT.config);
		expect(plain(run.stderr)).toContain(ALREADY);
		expect(run.stdout).toBe("");
		expect(holdsHex(run.stdout + run.stderr)).toBe(false);
		expect(lstatSync(identityPath("default")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(identityPath("default"))).toBe(elsewhere);
		if (kind === "live") {
			expect(readFileSync(elsewhere, "utf8")).toBe("not an identity\n");
		} else {
			expect(lstatSync(elsewhere, { throwIfNoEntry: false })).toBeUndefined();
		}
		expect(files()).toEqual(["identity.json"]);
	});

	it("--force still replaces the symlink with a private identity file, as a rename always did", async () => {
		const elsewhere = linkIdentity("live");
		const run = await agx("identity", "new", "--force");
		expect(run.code).toBe(EXIT.ok);
		expect(lstatSync(identityPath("default")).isSymbolicLink()).toBe(false);
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(readFileSync(elsewhere, "utf8")).toBe("not an identity\n");
	});
});

describe("agx identity new and import, on a file system that cannot make hard links", () => {
	const CODES = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"];
	const failLink = (code: string) => {
		gap.link = Object.assign(
			new Error(`${code}: operation not supported on socket, link '${identityPath("default")}.1.ab.tmp' -> '${identityPath("default")}'`),
			{ code },
		);
	};

	it.each(CODES)("identity new says so in plain words and writes nothing (%s)", async (code) => {
		failLink(code);
		const run = await agx("identity", "new");
		const shown = plain(run.stderr);
		expect(run.code).toBe(EXIT.config);
		expect(shown).toContain("hard links");
		expect(shown).toContain("AGX_HOME");
		expect(shown).toContain("agx identity new --force");
		expect(shown).not.toContain(code);
		expect(shown).not.toContain(".tmp");
		expect(shown).not.toContain("already has an identity");
		expect(run.stdout).toBe("");
		expect(holdsHex(run.stdout + run.stderr)).toBe(false);
		expect(files()).toEqual([]);
	});

	it.each(CODES)("identity import says so, and shows no part of the key (%s)", async (code) => {
		failLink(code);
		const run = await agx("identity", "import", incoming.secretKeyHex);
		const shown = plain(run.stderr);
		expect(run.code).toBe(EXIT.config);
		expect(shown).toContain("hard links");
		expect(shown).toContain("AGX_HOME");
		expect(shown).toContain("agx identity import <nsec> --force");
		expect(shown).not.toContain(".tmp");
		for (const out of [run.stdout, run.stderr]) {
			expect(out.includes(incoming.secretKeyHex)).toBe(false);
			expect(out.includes(INCOMING_NSEC)).toBe(false);
		}
		expect(run.stdout).toBe("");
		expect(files()).toEqual([]);
	});

	it("--force does not need hard links, so it still works there", async () => {
		failLink("ENOTSUP");
		const run = await agx("identity", "new", "--force");
		expect(run.code).toBe(EXIT.ok);
		expect(mode(identityPath("default"))).toBe(0o600);
		expect(files()).toEqual(["identity.json"]);
	});

	it("a failure of the link for another reason is not described as a missing feature", async () => {
		gap.link = Object.assign(new Error("EIO: i/o error, link"), { code: "EIO" });
		const run = await agx("identity", "new");
		expect(run.code).toBe(EXIT.generic);
		expect(run.stderr).toContain("EIO");
		expect(plain(run.stderr)).not.toContain("hard links");
		expect(files()).toEqual([]);
	});
});
