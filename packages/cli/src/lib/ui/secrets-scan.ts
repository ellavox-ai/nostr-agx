import { hexKeyRuns, type SecretKeyKind, secretKeyKinds } from "@nostr-agx/nostr";

/**
 * Warn before a message carries something that looks like a credential.
 *
 * A heuristic, not a guarantee: it catches the common shapes (a Nostr secret
 * key, PEM private keys, bearer and API tokens, cloud keys) so the user can stop
 * and think. It reports the kind and where, never the matched text.
 *
 * A Nostr secret key is read by the rule the CLI and the n8n nodes share, which lives in
 * `@nostr-agx/nostr`: `nsec1…` or `ncryptsec1…` in any case, behind `nostr:`, or written
 * as `%xx` escapes.
 */
export interface SecretFinding {
	kind: string;
	/** 1-based line of the match. */
	line: number;
}

const KEY_KINDS: Record<SecretKeyKind, string> = {
	nsec: "Nostr secret key (nsec1…)",
	ncryptsec: "Password-protected Nostr secret key (ncryptsec1…)",
};

const PATTERNS: { kind: string; re: RegExp }[] = [
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
];

/** 64 hex digits are as likely a public key or an event id: they only count when these words stand just before them. */
const WORDS_BEFORE_SECRET_HEX = /\b(?:secret|private)[^\n]{0,20}$/i;

export function scanForSecrets(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	const lines = text.split(/\r\n|[\n\r]/);
	lines.forEach((line, index) => {
		for (const key of secretKeyKinds(line)) {
			findings.push({ kind: KEY_KINDS[key], line: index + 1 });
		}
		for (const { kind, re } of PATTERNS) {
			if (re.test(line)) {
				findings.push({ kind, line: index + 1 });
			}
		}
		if (hexKeyRuns(line).some((run) => WORDS_BEFORE_SECRET_HEX.test(line.slice(0, run.index)))) {
			findings.push({ kind: "64-character hex secret", line: index + 1 });
		}
	});
	return findings;
}
