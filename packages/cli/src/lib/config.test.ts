import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandbox } from "../test/helpers.js";

// Count clients: an origin mismatch must be refused before one exists.
const created = vi.hoisted(() => ({ count: 0 }));
vi.mock("./api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./api.js")>();
	return {
		...actual,
		createApiClient: (...args: Parameters<typeof actual.createApiClient>) => {
			created.count += 1;
			return actual.createApiClient(...args);
		},
	};
});

const { searchCommand } = await import("../commands/search.js");
const {
	apiBaseUrlWasChosen,
	assertApiBaseUrl,
	DEFAULT_API_BASE_URL,
	getProfile,
	resolveApiCredentials,
	resolveApiKey,
	updateProfile,
} = await import("./config.js");
const { getCredential, setCredential } = await import("./credentials.js");
const { AgxCliError, EXIT } = await import("./errors.js");
const { setRuntimeForTests } = await import("./runtime.js");
type CredentialEntry = import("./credentials.js").CredentialEntry;

let box: ReturnType<typeof sandbox>;
beforeEach(() => {
	box = sandbox();
	created.count = 0;
});
afterEach(() => box.restore());

const ORIGIN = "https://app.ellaworks.ai";
const loginEntry = (overrides: Partial<CredentialEntry> = {}): CredentialEntry => ({
	apiBaseUrl: ORIGIN,
	apiKey: "ela_LOGIN",
	apiKeyId: "k_1",
	source: "login",
	clientId: "agx",
	organization: { id: "o_1", slug: "acme-robotics", name: "Acme Robotics" },
	user: { id: "u_1", email: "a•••@acme.com" },
	scopes: ["listings:read"],
	expiresAt: "2099-01-01T00:00:00.000Z",
	createdAt: "2026-09-30T00:00:00.000Z",
	...overrides,
});

function exitOf(fn: () => unknown): number | null {
	try {
		fn();
		return null;
	} catch (error) {
		if (error instanceof AgxCliError) {
			return error.exitCode;
		}
		throw error;
	}
}

describe("resolveApiKey precedence", () => {
	it("AGX_API_KEY > credentials.json > legacy config.json key", () => {
		updateProfile("default", { apiBaseUrl: ORIGIN });
		const config = JSON.parse(readFileSync(join(box.home, "config.json"), "utf8"));
		config.profiles.default.apiKey = "ela_LEGACY";
		writeFileSync(join(box.home, "config.json"), JSON.stringify(config));

		expect(resolveApiKey("default")).toMatchObject({ apiKey: "ela_LEGACY", source: "legacy-config" });

		setCredential("default", loginEntry());
		expect(resolveApiKey("default")).toMatchObject({ apiKey: "ela_LOGIN", source: "login" });

		process.env.AGX_API_KEY = "ela_ENV";
		expect(resolveApiKey("default")).toMatchObject({ apiKey: "ela_ENV", source: "env", entry: null });
	});

	it("no key at all is exit 3, pointing at agx login", () => {
		try {
			resolveApiKey("default");
			expect.unreachable();
		} catch (error) {
			expect((error as InstanceType<typeof AgxCliError>).exitCode).toBe(EXIT.config);
			expect((error as InstanceType<typeof AgxCliError>).remediation).toMatch(/agx login/);
		}
	});

	it("a key is refused (exit 3) for any other origin, and no client is created", async () => {
		updateProfile("default", { apiBaseUrl: ORIGIN, orgSlug: "acme-robotics" });
		setCredential("default", loginEntry());
		process.env.AGX_API_URL = "https://evil.example";
		expect(exitOf(() => resolveApiKey("default"))).toBe(EXIT.config);

		await expect(searchCommand("x", {})).rejects.toMatchObject({ exitCode: EXIT.config });
		expect(created.count).toBe(0);

		delete process.env.AGX_API_URL;
		updateProfile("default", { apiBaseUrl: "http://localhost:3000" });
		expect(exitOf(() => resolveApiKey("default"))).toBe(EXIT.config);
		expect(created.count).toBe(0);
	});

	it("an expired login is exit 4", () => {
		updateProfile("default", { apiBaseUrl: ORIGIN });
		setCredential("default", loginEntry({ expiresAt: "2026-10-01T00:00:00.000Z" }));
		const restore = setRuntimeForTests({ now: () => Date.parse("2026-10-02T00:00:00.000Z") });
		try {
			expect(exitOf(() => resolveApiKey("default"))).toBe(EXIT.auth);
		} finally {
			restore();
		}
	});
});

describe("resolveApiCredentials", () => {
	beforeEach(() => {
		updateProfile("default", { apiBaseUrl: ORIGIN });
		setCredential("default", loginEntry());
	});

	it("orgSlug: --org > AGX_ORG > profile.orgSlug > the login's org", () => {
		expect(resolveApiCredentials("default").orgSlug).toBe("acme-robotics");
		setCredential("default", loginEntry({ organization: null, source: "manual", clientId: null }));
		updateProfile("default", { orgSlug: "from-profile" });
		expect(resolveApiCredentials("default").orgSlug).toBe("from-profile");
		process.env.AGX_ORG = "from-env";
		expect(resolveApiCredentials("default").orgSlug).toBe("from-env");
		expect(resolveApiCredentials("default", { org: "from-flag" }).orgSlug).toBe("from-flag");
	});

	it("a login key asked to act on another org is exit 4", () => {
		expect(exitOf(() => resolveApiCredentials("default", { org: "other" }))).toBe(EXIT.auth);
		expect(resolveApiCredentials("default", { org: "acme-robotics" }).apiKey).toBe("ela_LOGIN");
	});

	it("no org anywhere is exit 3", () => {
		setCredential("default", loginEntry({ organization: null, source: "manual", clientId: null }));
		expect(exitOf(() => resolveApiCredentials("default"))).toBe(EXIT.config);
	});
});

describe("assertApiBaseUrl", () => {
	it("accepts https and loopback http, normalised", () => {
		expect(assertApiBaseUrl("https://app.ellaworks.ai/")).toBe("https://app.ellaworks.ai");
		expect(assertApiBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
		expect(assertApiBaseUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
		expect(assertApiBaseUrl("http://[::1]:3000")).toBe("http://[::1]:3000");
	});

	it.each([
		["plain http elsewhere", "http://app.ellaworks.ai"],
		["user info", "https://user:pass@app.ellaworks.ai"],
		["a query", "https://app.ellaworks.ai/?x=1"],
		["a fragment", "https://app.ellaworks.ai/#x"],
		["not a URL", "app.ellaworks.ai"],
		["another scheme", "ftp://app.ellaworks.ai"],
	])("refuses %s", (_label, url) => {
		expect(exitOf(() => assertApiBaseUrl(url))).toBe(EXIT.config);
	});

	it("never echoes a password", () => {
		try {
			assertApiBaseUrl("https://u:hunter2@example.com");
		} catch (error) {
			expect(String((error as Error).message)).not.toContain("hunter2");
		}
	});
});

describe("apiBaseUrlWasChosen", () => {
	it("a profile that names no server, or stores a built-in default, chose none", () => {
		expect(apiBaseUrlWasChosen("fresh")).toBe(false);
		for (const stored of [
			"https://app.ellaworks.ai",
			"https://app.ellaworks.ai/",
			"https://APP.ellaworks.ai",
			"http://localhost:3000",
			"http://localhost:3000/",
		]) {
			updateProfile("default", { apiBaseUrl: stored });
			expect(apiBaseUrlWasChosen("default"), stored).toBe(false);
		}
	});

	it("any other stored origin was chosen, and AGX_API_URL always is", () => {
		updateProfile("default", { apiBaseUrl: "https://staging.example.com" });
		expect(apiBaseUrlWasChosen("default")).toBe(true);
		updateProfile("default", { apiBaseUrl: "http://localhost:4000" });
		expect(apiBaseUrlWasChosen("default")).toBe(true);

		updateProfile("default", { apiBaseUrl: DEFAULT_API_BASE_URL });
		process.env.AGX_API_URL = DEFAULT_API_BASE_URL;
		expect(apiBaseUrlWasChosen("default")).toBe(true);
		expect(apiBaseUrlWasChosen("fresh")).toBe(true);
	});
});

describe("profiles", () => {
	it("a new profile defaults to the production server", () => {
		expect(DEFAULT_API_BASE_URL).toBe("https://app.ellaworks.ai");
		expect(getProfile("fresh").apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
	});

	it("moves a 0.3 config.json key into credentials.json on the next write", () => {
		writeFileSync(
			join(box.home, "config.json"),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "http://localhost:3000", apiKey: "ela_OLD", orgSlug: "acme" } },
			}),
		);
		const errors: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
			errors.push(String(m));
		});
		try {
			updateProfile("default", { nip05: "bot@acme.com" });
		} finally {
			spy.mockRestore();
		}
		expect(errors.join("\n")).toMatch(/Moved the API key of profile "default"/);
		expect(readFileSync(join(box.home, "config.json"), "utf8")).not.toContain("ela_OLD");
		expect(getCredential("default")).toMatchObject({
			apiKey: "ela_OLD",
			source: "migrated",
			apiBaseUrl: "http://localhost:3000",
		});
		expect(resolveApiKey("default").source).toBe("migrated");
	});
});
