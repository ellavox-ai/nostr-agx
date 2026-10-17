import { CARD_KIND, fetchByAuthorWithStatus } from "@nostr-agx/nostr";
import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	INodeCredentialTestResult,
} from "n8n-workflow";
import { identityFromCredentials, useWebSocket } from "./identity";

/**
 * Credential test: the key parses, and at least one relay answers a query.
 *
 * The query asks for this agent's own card, which is what a peer reading it
 * would ask. Whether a card exists does not matter here — a relay answering
 * with nothing is still a relay that answered.
 */
export async function testAgxCredential(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	let identity: ReturnType<typeof identityFromCredentials>;
	try {
		identity = identityFromCredentials(credential.data ?? {});
		useWebSocket();
	} catch (error) {
		return {
			status: "Error",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	const { answered } = await fetchByAuthorWithStatus({
		relays: identity.relays,
		author: identity.publicKey,
		kinds: [CARD_KIND],
		limit: 1,
		signer: identity.signer,
	});
	if (answered === 0) {
		return {
			status: "Error",
			message: `No relay answered (${identity.relays.join(", ")}). Check the URLs, and that the relays are running and reachable from n8n.`,
		};
	}
	return {
		status: "OK",
		message: `${answered} of ${identity.relays.length} relays answered for ${identity.npub}`,
	};
}
