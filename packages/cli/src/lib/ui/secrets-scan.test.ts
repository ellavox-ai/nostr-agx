import { describe, expect, it } from "vitest";
import { scanForSecrets } from "./secrets-scan.js";

describe("scanForSecrets", () => {
	it.each([
		["Nostr secret key", `nsec1${"q".repeat(58)}`],
		["private key block", "-----BEGIN OPENSSH PRIVATE KEY-----"],
		["bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789"],
		["Ellaworks API key", "ela_abcdefghijklmnop0123456789"],
		["OpenAI-style API key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
		["GitHub token", `ghp_${"a".repeat(36)}`],
		["AWS access key id", "AKIAABCDEFGHIJKLMNOP"],
		["Slack token", "xoxb-1234567890-abcdefghij"],
		["secret assigned in text", "password = hunter2hunter2hunter2"],
	])("flags a %s", (_name, text) => {
		expect(scanForSecrets(text).length).toBeGreaterThan(0);
	});

	it("leaves ordinary messages alone", () => {
		for (const text of [
			"Hi Alice, can you review invoice 1234?",
			"Our npub is npub1n0m8c4qn3434zy2q7nxj7v029pqyyfjfg0af98yfll6ksnvq3mps2ynyfz",
			"The deploy token expires tomorrow, please renew it.",
			"See https://example.com/docs for the API.",
		]) {
			expect(scanForSecrets(text)).toEqual([]);
		}
	});

	it("reports the line, never the secret", () => {
		const findings = scanForSecrets(`hello\nela_abcdefghijklmnop0123456789\nbye`);
		expect(findings).toEqual([{ kind: "Ellaworks API key (ela_…)", line: 2 }]);
		expect(JSON.stringify(findings)).not.toContain("abcdefghijklmnop");
	});
});
