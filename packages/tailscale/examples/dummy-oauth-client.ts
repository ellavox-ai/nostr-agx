/**
 * Tiny client for the local dummy OAuth endpoint.
 *
 * It authenticates with a client id/secret using the SDK's oauthAuthKey()
 * provider and reports that a real Tailscale auth key was minted. The key value
 * is never printed. Use example:two-agents-oauth to run the full flow against
 * the same endpoint.
 *
 *   export DUMMY_OAUTH_CLIENT_ID=... DUMMY_OAUTH_CLIENT_SECRET=...
 *   pnpm --filter @nostr-agx/tailscale dummy-oauth:client
 */
import { oauthAuthKey, TailscaleError } from "../src/index";

function env(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

async function main(): Promise<void> {
	const tokenUrl = env("DUMMY_OAUTH_URL") ?? "http://127.0.0.1:8787/oauth/token";
	const clientId = env("DUMMY_OAUTH_CLIENT_ID");
	const clientSecret = env("DUMMY_OAUTH_CLIENT_SECRET");
	if (!clientId || !clientSecret) {
		throw new Error(
			"Set DUMMY_OAUTH_CLIENT_ID and DUMMY_OAUTH_CLIENT_SECRET (the server prints a generated pair at startup).",
		);
	}

	const provider = oauthAuthKey({ clientId, clientSecret, tokenUrl });
	const authKey = await provider.resolve();
	if (!authKey) {
		throw new Error("The dummy OAuth endpoint did not return an auth key.");
	}
	console.info("OAuth client authenticated; a real Tailscale auth key was minted.");
	console.info(`token endpoint: ${tokenUrl}`);
	console.info(`auth key: ${authKey.length} characters (value redacted)`);
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		if (error instanceof TailscaleError) {
			console.error(`${error.code}: ${error.message}`);
			if (error.remediation) console.error(error.remediation);
		} else {
			console.error(error instanceof Error ? error.message : error);
		}
		process.exit(1);
	},
);
