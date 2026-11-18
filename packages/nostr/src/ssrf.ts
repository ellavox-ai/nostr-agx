/**
 * SSRF guard for outbound dials driven by peer-controlled data (a peer's
 * NIP-65 relay URLs, a NIP-05 `.well-known` host). Requires the allowed scheme,
 * then rejects the host if it is (or resolves to) a loopback / private (RFC-1918)
 * / CGNAT (100.64.0.0/10) / 0.0.0.0/8 / link-local (incl. the 169.254.169.254
 * cloud-metadata IP) / IETF-reserved (192.0.0.0/24, 198.18.0.0/15) / multicast
 * (224.0.0.0/4) / reserved+broadcast (240.0.0.0/4) / IPv6 ULA/link-local
 * (fe80::/10) / loopback / IPv4-mapped-IPv6 address. ALL resolved addresses are
 * checked.
 *
 * NODE-ONLY. DNS resolution needs `node:dns`; it is loaded LAZILY (dynamic import)
 * so a non-Node bundle doesn't fail to resolve it at load time. In a runtime
 * without `node:dns` the guard FAILS CLOSED: literal-IP destinations are still
 * classified and vetted, but any hostname that would require resolution is
 * REJECTED (we won't dial what we cannot vet). @nostr-agx/nostr's transport dials
 * WebSockets, so it is a Node package in practice — do not rely on it on edge.
 *
 * TOCTOU CAVEAT: `fetch`/`WebSocket` re-resolve DNS after this check, so a
 * DNS-rebinding record retains a check-to-use window. This guard is therefore
 * defense-in-depth, not an airtight control. It matters MORE here than in a
 * human-approved upload flow: AGX relay/NIP-05 URLs come straight off an
 * untrusted peer's Agent Card with no compensating human gate. Callers MUST also
 * bound fan-out (dedupe + cap the candidate set before checking) and never
 * surface raw dial/connect errors back to the peer (they are a resolution oracle).
 * A pinned-IP dial or a DNS cache shared with the connector would close the window.
 *
 * NOTE: a bracketed IPv6 literal host (`wss://[::1]`) is not recognized as an IP
 * here and falls to the DNS path (which fails → rejected); the IPv6
 * private-address logic covers addresses returned by DNS resolution.
 */

/** Lazily-loaded `node:dns` lookup — `null` in a runtime that lacks it (browser/
 * edge), where hostname resolution is unavailable and the guard fails closed. */
let dnsLookupPromise:
	| Promise<typeof import("node:dns/promises").lookup | null>
	| undefined;
function loadDnsLookup(): Promise<
	typeof import("node:dns/promises").lookup | null
> {
	if (!dnsLookupPromise) {
		dnsLookupPromise = import("node:dns/promises")
			.then((m) => m.lookup)
			.catch(() => null);
	}
	return dnsLookupPromise;
}

/** Lazily-loaded `node:net` isIP — falls back to a regex classifier when absent
 * so IP-literal destinations are still vetted off-Node. */
let isIpPromise: Promise<(host: string) => number> | undefined;
function loadIsIP(): Promise<(host: string) => number> {
	if (!isIpPromise) {
		isIpPromise = import("node:net")
			.then((m) => m.isIP)
			.catch(() => classifyIpFallback);
	}
	return isIpPromise;
}

/** Regex IP classifier (0 / 4 / 6), used only when `node:net` is unavailable. */
function classifyIpFallback(host: string): number {
	if (
		/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(
			host,
		)
	) {
		return 4;
	}
	if (host.includes(":") && /^[0-9a-f:.]+$/i.test(host)) {
		return 6;
	}
	return 0;
}

export interface UrlSafetyResult {
	ok: boolean;
	reason?: string;
}

export async function assertPublicUrl(
	rawUrl: string,
	opts: { protocols: string[] },
): Promise<UrlSafetyResult> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, reason: `invalid URL: "${rawUrl}"` };
	}

	if (!opts.protocols.includes(url.protocol)) {
		return {
			ok: false,
			reason: `only ${opts.protocols.join("/")} destinations are allowed`,
		};
	}

	const hostname = url.hostname.toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		return { ok: false, reason: "localhost destinations are not allowed" };
	}

	const isIP = await loadIsIP();
	let addresses: string[];
	if (isIP(hostname)) {
		addresses = [hostname];
	} else {
		const lookup = await loadDnsLookup();
		if (!lookup) {
			// No DNS in this runtime (browser/edge) — we can't vet a hostname, so
			// fail closed rather than dial something unverified.
			return {
				ok: false,
				reason: `cannot resolve host "${hostname}" in this runtime (DNS unavailable)`,
			};
		}
		try {
			const resolved = await lookup(hostname, { all: true });
			addresses = resolved.map((entry) => entry.address);
		} catch {
			return {
				ok: false,
				reason: `could not resolve host "${hostname}"`,
			};
		}
	}
	if (addresses.length === 0) {
		return {
			ok: false,
			reason: `host "${hostname}" resolved to no address`,
		};
	}

	for (const address of addresses) {
		if (isNonPublicAddress(address, isIP)) {
			return {
				ok: false,
				reason: `host "${hostname}" resolves to a non-public address (${address})`,
			};
		}
	}

	return { ok: true };
}

/** Convenience wrapper: public HTTPS only. */
export function assertPublicHttpsUrl(rawUrl: string): Promise<UrlSafetyResult> {
	return assertPublicUrl(rawUrl, { protocols: ["https:"] });
}

function isNonPublicAddress(
	address: string,
	isIP: (host: string) => number,
): boolean {
	const version = isIP(address);
	if (version === 4) {
		return isPrivateIPv4(address);
	}
	if (version === 6) {
		const mapped = mappedIPv4(address);
		if (mapped !== null && isPrivateIPv4(mapped)) {
			return true;
		}
		const lower = address.toLowerCase();
		// Loopback in both compressed (`::1`) and fully-expanded (`0:0:…:1`) forms.
		const isLoopback = lower === "::1" || /^(0+:){7}0*1$/.test(lower);
		return (
			isLoopback ||
			lower === "::" ||
			lower.startsWith("fc") || // fc00::/7 unique-local
			lower.startsWith("fd") ||
			/^fe[89ab]/.test(lower) || // fe80::/10 link-local (not just fe80::)
			lower.startsWith("2002:") // 6to4
		);
	}
	return true;
}

/**
 * The IPv4 address carried by an IPv4-mapped IPv6 address (::ffff:0:0/96), or
 * null if `address` is not one. `address` must already be a valid IPv6 address
 * (`isIP` returned 6). It reads the eight 16-bit groups, so the dotted form
 * (`::ffff:127.0.0.1`), the hex form (`::ffff:7f00:1`), zero padding, capitals
 * and any `::` abbreviation all give the same answer.
 */
function mappedIPv4(address: string): string | null {
	// A zone id (`%eth0`) names an interface; it is not part of the address.
	let text = address.replace(/%.*$/, "");
	// A dotted tail stands for the last two groups.
	const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
	if (dotted) {
		const [a, b, c, d] = dotted.slice(2).map(Number);
		text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	// `::` stands for as many zero groups as it takes to make eight.
	const halves = text.split("::");
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves[1] ? halves[1].split(":") : [];
	const zeros = Array<string>(8 - head.length - tail.length).fill("0");
	const groups = [...head, ...zeros, ...tail].map((g) =>
		Number.parseInt(g, 16),
	);
	// ::ffff:0:0/96 is five zero groups, then ffff; the last two groups are the
	// IPv4 address.
	if (groups.slice(0, 5).some((g) => g !== 0) || groups[5] !== 0xffff) {
		return null;
	}
	return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
}

function isPrivateIPv4(addr: string): boolean {
	return (
		addr.startsWith("127.") ||
		addr.startsWith("10.") ||
		addr.startsWith("192.168.") ||
		addr.startsWith("169.254.") ||
		/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addr) ||
		// 0.0.0.0/8 — not just the exact 0.0.0.0; e.g. 0.1.2.3 routes to localhost
		// on Linux.
		addr.startsWith("0.") ||
		// 100.64.0.0/10 (CGNAT, RFC 6598) — used by some cloud providers' internal
		// networks and by Tailscale.
		/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(addr) ||
		// 192.0.0.0/24 (IETF protocol assignments) and 198.18.0.0/15 (benchmarking).
		addr.startsWith("192.0.0.") ||
		/^198\.1[89]\./.test(addr) ||
		// 224.0.0.0/4 multicast.
		/^(22[4-9]|23[0-9])\./.test(addr) ||
		// 240.0.0.0/4 reserved — includes 255.255.255.255 limited broadcast.
		/^(24[0-9]|25[0-5])\./.test(addr)
	);
}
