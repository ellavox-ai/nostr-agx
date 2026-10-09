import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process stand-in for the Agent Index, for tests only.
 *
 * `node:http` on 127.0.0.1:0, serving the contract fixture
 * (`fixtures/contract-v1.json`) for the device endpoints and the RPC
 * procedures `agx login` and friends call. It implements the
 * LOGIN-CONTRACT.md §1.3 rules for real — pacing, single use, client binding —
 * so the CLI is tested against
 * the contract rather than against a script. Every request is logged.
 */

export const CONTRACT = JSON.parse(
	readFileSync(new URL("./fixtures/contract-v1.json", import.meta.url), "utf8"),
) as ContractFixture;

export interface ContractFixture {
	scopes: string[];
	deviceCode: {
		response: Record<string, unknown>;
		legacyExpiresIn: number;
		errors: Record<string, MockResponse>;
	};
	deviceToken: {
		success: Record<string, unknown> & {
			user: { id: string; email: string; name: string };
			organization: { id: string; slug: string; name: string };
		};
		errors: Record<string, MockResponse>;
	};
	principal: { output: Record<string, unknown> & { apiKey: Record<string, unknown> } };
	organizationsList: { output: Array<Record<string, unknown>> };
	apiKeysDelete: { output: Record<string, unknown> };
	rpcErrors: Record<string, MockResponse>;
}

export interface MockResponse {
	status: number;
	headers?: Record<string, string>;
	/** JSON-encoded unless `raw` is set. */
	body?: unknown;
	raw?: string;
}

export interface LoggedRequest {
	method: string;
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

export type CodeStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface Organization {
	id: string;
	slug: string;
	name: string;
}

export interface CodeRecord {
	deviceCode: string;
	userCode: string;
	clientId: string | null;
	scope: string | null;
	request: Record<string, unknown>;
	status: CodeStatus;
	interval: number;
	lastPolledAt: number | null;
	expiresAt: number;
	organization: Organization | null;
	user: { id: string; email: string; name: string } | null;
}

export interface KeyRecord {
	id: string;
	key: string;
	name: string;
	organization: Organization;
	user: { id: string; email: string };
	scoped: boolean;
	scopes: string[];
	clientId: string | null;
	hostLabel: string | null;
	expiresAt: string | null;
	revoked: boolean;
	/** False once the key's owner has left the key's organization. */
	member: boolean;
}

export type RpcHandler = (
	input: unknown,
	key: KeyRecord,
) => MockResponse | { output: unknown } | Promise<MockResponse | { output: unknown }>;

export interface MockIndexServer {
	/** `http://127.0.0.1:<port>`, no trailing slash. */
	origin: string;
	requests: LoggedRequest[];
	codes: CodeRecord[];
	keys: KeyRecord[];
	/** Approve the newest (or the named) pending code. */
	approve(options?: {
		userCode?: string;
		organization?: Organization;
		user?: { id: string; email: string; name: string };
	}): CodeRecord;
	deny(userCode?: string): CodeRecord;
	expire(userCode?: string): CodeRecord;
	/** Answer the next /token call with this instead of the rules. */
	queueToken(response: MockResponse): void;
	/** Answer the next /code call with this instead of the fixture. */
	queueCode(response: MockResponse): void;
	/** Called on every /token request before it is answered. */
	onTokenPoll: ((code: CodeRecord | undefined, count: number) => void) | null;
	/** Add or replace an RPC procedure, keyed by its path after `/api/rpc/`. */
	setRpc(path: string, handler: RpcHandler): void;
	/** A key the server knows without a login (a Settings key). */
	addKey(partial?: Partial<KeyRecord>): KeyRecord;
	/** Requests to a path (no query string). */
	calls(path: string): LoggedRequest[];
	close(): Promise<void>;
}

export interface MockOptions {
	/** The server's clock (ms). Share it with the CLI's runtime in tests. */
	now?: () => number;
	/** Behave like a server that predates the login contract: no `scope` echo
	 * on /code. */
	omitScopeEcho?: boolean;
	/** Put the verification page on this origin instead of the server's own. */
	verificationOrigin?: string;
	/** Organizations a legacy (unscoped) key sees, besides its own. */
	extraOrganizations?: Array<Organization & { role: string }>;
}

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const KNOWN_CLIENTS = new Set(["agx", "vscode"]);
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomUserCode(): string {
	const pick = () =>
		USER_CODE_ALPHABET[randomBytes(1)[0] % USER_CODE_ALPHABET.length];
	const part = () => Array.from({ length: 4 }, pick).join("");
	return `${part()}-${part()}`;
}

function randomKey(): string {
	return `ela_${Array.from(
		randomBytes(64),
		(b) => LETTERS[b % LETTERS.length],
	).join("")}`;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function send(res: ServerResponse, response: MockResponse): void {
	const headers: Record<string, string> = {
		"Cache-Control": "no-store",
		Pragma: "no-cache",
		...(response.raw === undefined
			? { "Content-Type": "application/json" }
			: {}),
		...response.headers,
	};
	res.writeHead(response.status, headers);
	res.end(
		response.raw !== undefined
			? response.raw
			: response.body === undefined
				? ""
				: JSON.stringify(response.body),
	);
}

function oauth(status: number, body: Record<string, unknown>): MockResponse {
	return { status, body };
}

function rpcError(name: string): MockResponse {
	const fixture = CONTRACT.rpcErrors[name];
	if (!fixture) {
		throw new Error(`no fixture for ${name}`);
	}
	return structuredClone(fixture);
}

function rpcNotFound(): MockResponse {
	return {
		status: 404,
		body: {
			json: {
				defined: false,
				code: "NOT_FOUND",
				status: 404,
				message: "Not found",
			},
		},
	};
}

export async function startMockIndexServer(
	options: MockOptions = {},
): Promise<MockIndexServer> {
	const now = options.now ?? (() => Date.now());
	const requests: LoggedRequest[] = [];
	const codes: CodeRecord[] = [];
	const keys: KeyRecord[] = [];
	const tokenQueue: MockResponse[] = [];
	const codeQueue: MockResponse[] = [];
	const rpc = new Map<string, RpcHandler>();
	let tokenPolls = 0;
	let keySeq = 0;
	let origin = "";

	const fixtureOrg = CONTRACT.deviceToken.success.organization;
	const fixtureUser = CONTRACT.deviceToken.success.user;

	const mintKey = (code: CodeRecord): KeyRecord => {
		keySeq += 1;
		const scoped = code.clientId === "agx";
		const record: KeyRecord = {
			id: `k_${keySeq}`,
			key: randomKey(),
			name: `agx-test-${keySeq}`,
			organization: code.organization ?? fixtureOrg,
			user: {
				id: code.user?.id ?? fixtureUser.id,
				email: code.user?.email ?? fixtureUser.email,
			},
			scoped,
			scopes: scoped ? (code.scope ?? "").split(" ").filter(Boolean) : [],
			clientId: code.clientId,
			hostLabel:
				typeof code.request.host_label === "string"
					? code.request.host_label
					: null,
			expiresAt: scoped
				? new Date(now() + 90 * 86_400_000).toISOString()
				: null,
			revoked: false,
			member: true,
		};
		keys.push(record);
		return record;
	};

	const handleCode = (body: Record<string, unknown>): MockResponse => {
		const queued = codeQueue.shift();
		if (queued) {
			return queued;
		}
		const clientId =
			typeof body.client_id === "string" ? body.client_id : null;
		if (clientId !== null && !KNOWN_CLIENTS.has(clientId)) {
			return structuredClone(CONTRACT.deviceCode.errors.invalid_client as MockResponse);
		}
		const template = CONTRACT.deviceCode.response;
		const userCode =
			codes.length === 0 ? String(template.user_code) : randomUserCode();
		const pageOrigin = options.verificationOrigin ?? origin;
		const expiresIn =
			clientId === "agx"
				? Number(template.expires_in)
				: CONTRACT.deviceCode.legacyExpiresIn;
		const scope =
			clientId === "agx"
				? typeof body.scope === "string"
					? body.scope
					: String(template.scope)
				: null;
		const record: CodeRecord = {
			deviceCode: randomBytes(32).toString("hex"),
			userCode,
			clientId,
			scope,
			request: body,
			status: "pending",
			interval: Number(template.interval),
			lastPolledAt: null,
			expiresAt: now() + expiresIn * 1000,
			organization: null,
			user: null,
		};
		codes.push(record);
		const response: Record<string, unknown> = {
			device_code: record.deviceCode,
			user_code: record.userCode,
			verification_uri: `${pageOrigin}/auth/device`,
			verification_uri_complete: `${pageOrigin}/auth/device?code=${record.userCode}`,
			expires_in: expiresIn,
			interval: record.interval,
		};
		if (clientId !== null && !options.omitScopeEcho && scope) {
			response.scope = scope;
		}
		return { status: 200, body: response };
	};

	const handleToken = (body: Record<string, unknown>): MockResponse => {
		const deviceCode =
			typeof body.device_code === "string" ? body.device_code : null;
		const record = deviceCode
			? codes.find((c) => c.deviceCode === deviceCode)
			: undefined;
		tokenPolls += 1;
		server.onTokenPoll?.(record, tokenPolls);
		const queued = tokenQueue.shift();
		if (queued) {
			return queued;
		}
		// LOGIN-CONTRACT.md §1.3, in order.
		if (!deviceCode) {
			return oauth(400, { error: "invalid_request" });
		}
		if (!record) {
			return oauth(400, { error: "invalid_grant", error_description: "Invalid device code" });
		}
		const clientId = typeof body.client_id === "string" ? body.client_id : null;
		if (clientId !== null && !KNOWN_CLIENTS.has(clientId)) {
			return oauth(400, { error: "invalid_client" });
		}
		if (record.clientId !== null) {
			if (body.grant_type === undefined) {
				return oauth(400, { error: "invalid_request" });
			}
			if (body.grant_type !== GRANT_TYPE) {
				return oauth(400, { error: "unsupported_grant_type" });
			}
			if (clientId !== record.clientId) {
				return oauth(400, { error: "invalid_grant" });
			}
		}
		const t = now();
		if (t > record.expiresAt && (record.status === "pending" || record.status === "approved")) {
			record.status = "expired";
			return oauth(400, { error: "expired_token" });
		}
		if (record.status === "expired") {
			return oauth(400, { error: "expired_token" });
		}
		if (record.status === "denied") {
			return oauth(400, { error: "access_denied" });
		}
		if (record.status === "consumed") {
			return oauth(400, { error: "invalid_grant", error_description: "Device code already used" });
		}
		if (record.status === "pending") {
			const tooSoon =
				record.lastPolledAt !== null &&
				t < record.lastPolledAt + (record.interval - 1) * 1000;
			if (tooSoon) {
				if (record.clientId === "agx") {
					record.interval = Math.min(record.interval + 5, 60);
				}
				return oauth(400, { error: "slow_down", interval: record.interval });
			}
			record.lastPolledAt = t;
			return oauth(400, { error: "authorization_pending" });
		}
		// approved → consumed, exactly once.
		record.status = "consumed";
		const key = mintKey(record);
		const success = structuredClone(CONTRACT.deviceToken.success);
		const expiresAt = key.expiresAt;
		const response: Record<string, unknown> = {
			...success,
			access_token: key.key,
			api_key_id: key.id,
			expires_in: expiresAt
				? Math.floor((Date.parse(expiresAt) - t) / 1000)
				: null,
			expires_at: expiresAt,
			user: { ...success.user, id: key.user.id, email: key.user.email },
			organization: key.organization,
		};
		if (key.scoped) {
			response.scope = key.scopes.join(" ");
		} else {
			delete response.scope;
		}
		return { status: 200, body: response };
	};

	const defaultRpc: Record<string, RpcHandler> = {
		"account/principal/get": (_input, key) => {
			const template = structuredClone(CONTRACT.principal.output);
			const [first = "?"] = key.user.email;
			return {
				output: {
					...template,
					user: {
						id: key.user.id,
						emailMasked: `${first}•••${key.user.email.slice(key.user.email.indexOf("@"))}`,
					},
					// LOGIN-CONTRACT.md §1.5: a key whose owner has left its
					// organization is answered, with `organization: null`.
					organization: key.member
						? { ...key.organization, role: "owner" }
						: null,
					apiKey: {
						...template.apiKey,
						id: key.id,
						name: key.name,
						start: key.key.slice(0, 6),
						scoped: key.scoped,
						scopes: key.scopes,
						clientId: key.clientId,
						hostLabel: key.hostLabel,
						expiresAt: key.expiresAt,
					},
				},
			};
		},
		"organizations/list": (_input, key) => {
			const own = {
				...structuredClone(CONTRACT.organizationsList.output[0]),
				...key.organization,
			};
			const extra = options.extraOrganizations ?? [
				{ id: "o_2", slug: "other-org", name: "Other Org", role: "member" },
			];
			return { output: key.scoped ? [own] : [own, ...extra] };
		},
		"prm/apiKeys/delete": (input, key) => {
			const apiKeyId = (input as { apiKeyId?: unknown })?.apiKeyId;
			if (apiKeyId !== key.id) {
				return rpcError("API_KEY_SELF_REVOKE_ONLY");
			}
			key.revoked = true;
			return { output: structuredClone(CONTRACT.apiKeysDelete.output) };
		},
		"agentIndex/publishListing": () => rpcError("HUMAN_CONFIRMATION_REQUIRED"),
	};

	const handleRpc = async (
		path: string,
		headers: IncomingMessage["headers"],
		body: unknown,
	): Promise<MockResponse> => {
		const handler = rpc.get(path) ?? defaultRpc[path];
		const presented = headers["x-api-key"];
		const key = keys.find((k) => k.key === presented);
		if (!key || key.revoked) {
			return rpcError("API_KEY_INVALID");
		}
		if (key.expiresAt && Date.parse(key.expiresAt) <= now()) {
			return rpcError("API_KEY_EXPIRED");
		}
		if (!handler) {
			return rpcNotFound();
		}
		// A former member's key may still say who it is and revoke itself;
		// everything else is refused (LOGIN-CONTRACT.md §1.5, §1.7).
		if (
			!key.member &&
			path !== "account/principal/get" &&
			path !== "prm/apiKeys/delete"
		) {
			return rpcError("API_KEY_OWNER_NOT_MEMBER");
		}
		const input = (body as { json?: unknown } | null)?.json;
		const result = await handler(input, key);
		if ("output" in result) {
			return { status: 200, body: { json: result.output } };
		}
		return result;
	};

	const http = createServer((req, res) => {
		void (async () => {
			const text = await readBody(req);
			let body: unknown = text;
			try {
				body = text ? JSON.parse(text) : null;
			} catch {
				body = text;
			}
			const url = new URL(req.url ?? "/", origin);
			requests.push({
				method: req.method ?? "GET",
				path: url.pathname,
				headers: req.headers,
				body,
			});
			const json = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
			if (req.method === "POST" && url.pathname === "/api/auth/device/code") {
				send(res, handleCode(json));
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/auth/device/token") {
				send(res, handleToken(json));
				return;
			}
			if (req.method === "POST" && url.pathname.startsWith("/api/rpc/")) {
				send(res, await handleRpc(url.pathname.slice("/api/rpc/".length), req.headers, body));
				return;
			}
			send(res, { status: 404, raw: "<html>not found</html>", headers: { "Content-Type": "text/html" } });
		})().catch((error: unknown) => {
			send(res, { status: 500, body: { error: "server_error", error_description: String(error) } });
		});
	});

	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

	const pick = (userCode?: string): CodeRecord => {
		const record = userCode
			? codes.find((c) => c.userCode === userCode)
			: codes[codes.length - 1];
		if (!record) {
			throw new Error("mock: no such device code");
		}
		return record;
	};

	const server: MockIndexServer = {
		origin,
		requests,
		codes,
		keys,
		approve(opts) {
			const record = pick(opts?.userCode);
			record.status = "approved";
			record.organization = opts?.organization ?? fixtureOrg;
			record.user = opts?.user ?? fixtureUser;
			return record;
		},
		deny(userCode) {
			const record = pick(userCode);
			record.status = "denied";
			return record;
		},
		expire(userCode) {
			const record = pick(userCode);
			record.expiresAt = now() - 1;
			return record;
		},
		queueToken(response) {
			tokenQueue.push(response);
		},
		queueCode(response) {
			codeQueue.push(response);
		},
		onTokenPoll: null,
		setRpc(path, handler) {
			rpc.set(path, handler);
		},
		addKey(partial) {
			keySeq += 1;
			const record: KeyRecord = {
				id: `k_${keySeq}`,
				key: randomKey(),
				name: `settings-${keySeq}`,
				organization: fixtureOrg,
				user: { id: fixtureUser.id, email: fixtureUser.email },
				scoped: false,
				scopes: [],
				clientId: null,
				hostLabel: null,
				expiresAt: null,
				revoked: false,
				member: true,
				...partial,
			};
			keys.push(record);
			return record;
		},
		calls(path) {
			return requests.filter((r) => r.path === path);
		},
		close() {
			return new Promise<void>((resolve) => {
				http.closeAllConnections?.();
				http.close(() => resolve());
			});
		},
	};
	return server;
}
