import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "./ssrf";

const wss = { protocols: ["wss:"] };

describe("assertPublicUrl", () => {
	it("rejects a disallowed protocol", async () => {
		expect((await assertPublicUrl("http://1.1.1.1", wss)).ok).toBe(false);
		expect((await assertPublicUrl("https://1.1.1.1", wss)).ok).toBe(false);
		expect(
			(
				await assertPublicUrl("https://1.1.1.1", {
					protocols: ["https:"],
				})
			).ok,
		).toBe(true);
	});

	it("rejects localhost by name (no DNS)", async () => {
		expect((await assertPublicUrl("wss://localhost", wss)).ok).toBe(false);
		expect((await assertPublicUrl("wss://api.localhost", wss)).ok).toBe(
			false,
		);
	});

	it("rejects loopback / private / link-local / metadata IPv4 literals", async () => {
		for (const ip of [
			"127.0.0.1",
			"10.0.0.5",
			"192.168.1.1",
			"169.254.169.254", // cloud metadata
			"172.16.0.1",
			"172.31.255.255",
			"0.0.0.0",
			"0.1.2.3", // 0.0.0.0/8 — routes to localhost on Linux
			"100.64.0.1", // CGNAT (RFC 6598)
			"100.127.255.255", // CGNAT upper bound
			"192.0.0.1", // IETF protocol assignments (192.0.0.0/24)
			"198.18.0.1", // benchmarking (198.18.0.0/15)
			"198.19.255.255", // benchmarking upper bound
			"224.0.0.1", // multicast (224.0.0.0/4)
			"239.255.255.255", // multicast upper bound
			"240.0.0.1", // reserved (240.0.0.0/4)
			"255.255.255.255", // limited broadcast
		]) {
			const r = await assertPublicUrl(`wss://${ip}`, wss);
			expect(r.ok, ip).toBe(false);
		}
	});

	it("accepts a public IPv4 literal (no DNS) and returns it for pinning", async () => {
		expect(await assertPublicUrl("wss://1.1.1.1", wss)).toMatchObject({
			ok: true,
			addresses: ["1.1.1.1"],
		});
		expect((await assertPublicUrl("wss://8.8.8.8:443", wss)).ok).toBe(true);
		// 172.15/172.32 are OUTSIDE the private 172.16–172.31 range.
		expect((await assertPublicUrl("wss://172.15.0.1", wss)).ok).toBe(true);
		expect((await assertPublicUrl("wss://172.32.0.1", wss)).ok).toBe(true);
		// 100.63/100.128 are OUTSIDE the CGNAT 100.64–100.127 range.
		expect((await assertPublicUrl("wss://100.63.0.1", wss)).ok).toBe(true);
		expect((await assertPublicUrl("wss://100.128.0.1", wss)).ok).toBe(true);
		// 198.17/198.20 are OUTSIDE the 198.18–198.19 range.
		expect((await assertPublicUrl("wss://198.17.0.1", wss)).ok).toBe(true);
		expect((await assertPublicUrl("wss://198.20.0.1", wss)).ok).toBe(true);
	});

	it("rejects a malformed URL", async () => {
		expect((await assertPublicUrl("not a url", wss)).ok).toBe(false);
		expect((await assertPublicUrl("", wss)).ok).toBe(false);
	});
});
