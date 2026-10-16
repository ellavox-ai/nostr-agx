import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../test/helpers.js";
import { getProfile, updateProfile } from "./config.js";
import {
	type CredentialEntry,
	getCredential,
	isExpired,
	listCredentials,
	removeCredential,
	setCredential,
} from "./credentials.js";
import { AgxCliError, EXIT } from "./errors.js";

let box: ReturnType<typeof sandbox>;
beforeEach(() => {
	box = sandbox();
});
afterEach(() => box.restore());

const entry = (overrides: Partial<CredentialEntry> = {}): CredentialEntry => ({
	apiBaseUrl: "https://app.ellaworks.ai",
	apiKey: "ela_SecretSecretSecretSecretSecretSecret",
	apiKeyId: "k_1",
	source: "login",
	clientId: "agx",
	organization: { id: "o_1", slug: "acme-robotics", name: "Acme Robotics" },
	user: { id: "u_1", email: "a•••@acme.com" },
	scopes: ["listings:read", "listings:write", "domains:read", "domains:write"],
	expiresAt: "2026-12-29T18:04:11.000Z",
	createdAt: "2026-09-30T18:04:11.000Z",
	...overrides,
});

describe("credentials.json", () => {
	it("round-trips entries per profile", () => {
		expect(getCredential("default")).toBeNull();
		setCredential("default", entry());
		setCredential("work", entry({ apiKeyId: "k_2", source: "manual", clientId: null }));
		expect(getCredential("default")).toEqual(entry());
		expect(Object.keys(listCredentials())).toEqual(["default", "work"]);
		expect(removeCredential("default")).toBe(true);
		expect(removeCredential("default")).toBe(false);
		expect(getCredential("default")).toBeNull();
		expect(getCredential("work")?.apiKeyId).toBe("k_2");
	});

	it("is 0600 inside a 0700 home, and leaves no temp files behind", () => {
		setCredential("default", entry());
		setCredential("default", entry({ apiKeyId: "k_3" }));
		const path = join(box.home, "credentials.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(box.home).mode & 0o777).toBe(0o700);
		expect(readdirSync(box.home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			version: 1,
			profiles: { default: { apiKeyId: "k_3" } },
		});
	});

	it("re-reads the file before each write, so writers do not drop each other's entries", () => {
		setCredential("a", entry());
		// Another process adds a profile behind this one's back.
		const path = join(box.home, "credentials.json");
		const file = JSON.parse(readFileSync(path, "utf8"));
		file.profiles.b = entry({ apiKeyId: "k_b" });
		writeFileSync(path, JSON.stringify(file));
		setCredential("c", entry({ apiKeyId: "k_c" }));
		expect(Object.keys(listCredentials()).sort()).toEqual(["a", "b", "c"]);
	});

	it("a malformed file is exit 3 and the error never quotes it", () => {
		const path = join(box.home, "credentials.json");
		writeFileSync(path, '{"version":1,"profiles":{"default":{"apiKey":"ela_LEAKME"', { mode: 0o600 });
		for (const read of [() => getCredential("default"), () => setCredential("x", entry())]) {
			try {
				read();
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(AgxCliError);
				expect((error as AgxCliError).exitCode).toBe(EXIT.config);
				expect((error as AgxCliError).message).not.toContain("LEAKME");
			}
		}
		writeFileSync(path, JSON.stringify({ version: 1, profiles: { default: { apiKey: 42 } } }));
		expect(() => getCredential("default")).toThrow(/expected shape/);
	});

	it("storing a credential never writes a key into config.json", () => {
		updateProfile("default", { orgSlug: "acme-robotics" });
		setCredential("default", entry());
		const config = readFileSync(join(box.home, "config.json"), "utf8");
		expect(config).not.toContain("ela_");
		expect(getProfile("default").apiKey).toBeNull();
		expect(existsSync(join(box.home, "credentials.json"))).toBe(true);
	});

	it("knows when an entry has expired", () => {
		const at = Date.parse("2026-12-29T18:04:11.000Z");
		expect(isExpired(entry(), at - 1)).toBe(false);
		expect(isExpired(entry(), at)).toBe(true);
		expect(isExpired(entry({ expiresAt: null }), at * 2)).toBe(false);
	});
});
