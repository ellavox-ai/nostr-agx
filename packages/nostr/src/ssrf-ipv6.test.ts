import { describe, expect, it, vi } from "vitest";

// Mock DNS so a hostname resolves to a chosen IPv6 address. The IPv6 branch is
// otherwise unreachable in a test: a bracketed literal (`wss://[::1]`) falls to
// the DNS path (and fails there), so only a resolver result exercises it.
const mockLookup = vi.fn();
vi.mock("node:dns/promises", () => ({
	lookup: (...a: unknown[]) => mockLookup(...a),
}));

import { assertPublicUrl } from "./ssrf";

const wss = { protocols: ["wss:"] };

function resolvesTo(address: string) {
	mockLookup.mockResolvedValue([
		{ address, family: address.includes(":") ? 6 : 4 },
	]);
}

describe("assertPublicUrl IPv6 classification (DNS-resolved)", () => {
	it("rejects fe80::/10 link-local beyond the exact fe80 prefix", async () => {
		for (const a of ["fe80::1", "fe90::1", "fea0::1", "febf::1"]) {
			resolvesTo(a);
			expect(
				(await assertPublicUrl("wss://host.example", wss)).ok,
				a,
			).toBe(false);
		}
	});

	it("rejects loopback (compressed + expanded) and unique-local", async () => {
		for (const a of ["::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456::1"]) {
			resolvesTo(a);
			expect(
				(await assertPublicUrl("wss://host.example", wss)).ok,
				a,
			).toBe(false);
		}
	});

	it("rejects an IPv4-mapped private address", async () => {
		resolvesTo("::ffff:10.0.0.1");
		expect((await assertPublicUrl("wss://host.example", wss)).ok).toBe(
			false,
		);
	});

	it("accepts a public IPv6 address", async () => {
		resolvesTo("2606:4700::1111"); // Cloudflare
		expect((await assertPublicUrl("wss://host.example", wss)).ok).toBe(
			true,
		);
	});
});

describe("assertPublicUrl IPv4-mapped IPv6 addresses (DNS-resolved)", () => {
	// An address in ::ffff:0:0/96 is judged by the IPv4 address it carries,
	// however it is written. The values are chosen so that reading the two
	// 16-bit groups in the wrong order, or the two bytes of a group in the wrong
	// order, gives a different verdict.
	async function isPublic(address: string): Promise<boolean> {
		resolvesTo(address);
		return (await assertPublicUrl("wss://host.example", wss)).ok;
	}

	describe("rejected: the IPv4 address it carries is not public", () => {
		it.each([
			["::ffff:7f00:1", "127.0.0.1"],
			["::ffff:a00:1", "10.0.0.1"],
			["::ffff:c0a8:101", "192.168.1.1"],
			["::ffff:a9fe:a9fe", "169.254.169.254, the cloud metadata address"],
			["::ffff:ac10:1", "172.16.0.1"],
			["::ffff:c000:1", "192.0.0.1, where the third byte decides"],
			["::ffff:a00:808", "10.0.8.8, where the group order decides"],
			["::ffff:0:1", "0.0.0.1"],
			["::ffff:ffff:ffff", "255.255.255.255"],
		])("hex form %s (= %s)", async (address) => {
			expect(await isPublic(address)).toBe(false);
		});

		it.each([
			["::ffff:7f00:0001", "zero-padded"],
			["::ffff:0a00:0001", "zero-padded"],
			["::FFFF:7F00:1", "capital letters"],
			["::Ffff:C0A8:0101", "capital letters and zero-padded"],
		])("hex form %s (%s)", async (address) => {
			expect(await isPublic(address)).toBe(false);
		});

		it.each([
			["0:0:0:0:0:ffff:7f00:1", "written in full"],
			["0000:0000:0000:0000:0000:ffff:7f00:0001", "written in full, zero-padded"],
			["0:0:0:0:0:ffff:127.0.0.1", "written in full, dotted tail"],
			["0::ffff:7f00:1", "abbreviated from the left"],
			["0:0:0::ffff:a00:1", "abbreviated in the middle"],
			["::0:0:ffff:c0a8:101", "abbreviated, with zero groups after the ::"],
		])("%s (%s)", async (address) => {
			expect(await isPublic(address)).toBe(false);
		});

		it.each([
			"::ffff:127.0.0.1",
			"::ffff:192.168.1.1",
			"::ffff:169.254.169.254",
			"::ffff:192.0.0.1",
			"::FFFF:10.0.0.1",
		])("dotted form %s", async (address) => {
			expect(await isPublic(address)).toBe(false);
		});

		it.each([
			["::ffff:7f00:1%eth0", "hex form"],
			["::ffff:7f00:1%1", "hex form, numeric zone"],
			["::ffff:7f00:1%a:b", "hex form, zone with a colon"],
			["::ffff:127.0.0.1%eth0", "dotted form"],
		])("%s carries a zone id (%s)", async (address) => {
			expect(await isPublic(address)).toBe(false);
		});
	});

	describe("accepted: the IPv4 address it carries is public", () => {
		it.each([
			["::ffff:808:808", "8.8.8.8"],
			["::ffff:8.8.8.8", "8.8.8.8, dotted"],
			["::ffff:101:101", "1.1.1.1"],
			["0:0:0:0:0:ffff:808:808", "8.8.8.8, written in full"],
			["::FFFF:0808:0808", "8.8.8.8, capital letters and zero-padded"],
			["::ffff:a8c0:101", "168.192.1.1, not 192.168.1.1"],
			["::ffff:808:a00", "8.8.10.0, not 10.0.8.8"],
			["::ffff:c000:101", "192.0.1.1, where the third byte decides"],
			["::ffff:808:808%eth0", "8.8.8.8, with a zone id"],
		])("%s (= %s)", async (address) => {
			expect(await isPublic(address)).toBe(true);
		});
	});

	describe("accepted: the address is not a mapped address", () => {
		it.each([
			["2606:4700::7f00:1", "the last 32 bits read 127.0.0.1, but there is no ::ffff:"],
			["2606:4700::a00:1", "the last 32 bits read 10.0.0.1, but there is no ::ffff:"],
			["::1:ffff:a00:1", "a non-zero group before ffff"],
			["1::ffff:a00:1", "a non-zero first group"],
			["::fffe:a00:1", "fffe, not ffff"],
		])("%s (%s)", async (address) => {
			expect(await isPublic(address)).toBe(true);
		});

		it.each([
			["2606:4700::ffff:a00:1", "hex tail"],
			["2606:4700::ffff:10.0.0.1", "dotted tail"],
		])("%s contains ::ffff: but is an ordinary global address (%s)", async (address) => {
			expect(await isPublic(address)).toBe(true);
		});
	});
});
