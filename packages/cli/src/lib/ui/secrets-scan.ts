/**
 * Warn before a message carries something that looks like a credential.
 *
 * A heuristic, not a guarantee: it catches the common shapes (a Nostr secret
 * key, PEM private keys, bearer and API tokens, cloud keys) so the user can stop
 * and think. It reports the kind and where, never the matched text.
 */
export interface SecretFinding {
	kind: string;
	/** 1-based line of the match. */
	line: number;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
	{ kind: "Nostr secret key (nsec1…)", re: /\bnsec1[02-9ac-hj-np-z]{20,}\b/ },
	{ kind: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ kind: "bearer token", re: /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
	{ kind: "Ellaworks API key (ela_…)", re: /\bela_[A-Za-z0-9]{16,}\b/ },
	{ kind: "OpenAI-style API key (sk-…)", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
	{ kind: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
	{ kind: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
	{
		kind: "secret assigned in text",
		re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{16,}/i,
	},
	{ kind: "64-character hex secret", re: /\b(?:secret|private)[^\n]{0,20}\b[0-9a-f]{64}\b/i },
];

export function scanForSecrets(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	const lines = text.split(/\r\n|[\n\r]/);
	lines.forEach((line, index) => {
		for (const { kind, re } of PATTERNS) {
			if (re.test(line)) {
				findings.push({ kind, line: index + 1 });
			}
		}
	});
	return findings;
}
