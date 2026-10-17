import type { Icon, ICredentialType, INodeProperties } from "n8n-workflow";

/**
 * An AGX agent identity: the Nostr secret key the agent signs and decrypts
 * with, and the relays it reads its inbox from and publishes to.
 *
 * Tested by the nodes' `agxApiTest` method (there is no HTTP endpoint to test
 * against): it checks the key and asks each relay for this agent's card.
 */
export class AgxApi implements ICredentialType {
	name = "agxApi";

	displayName = "AGX Agent Identity API";

	icon: Icon = {
		light: "file:../icons/agx.svg",
		dark: "file:../icons/agx.dark.svg",
	};

	documentationUrl =
		"https://github.com/ellavox-ai/nostr-agx/tree/main/packages/n8n-nodes-agx#credentials";

	properties: INodeProperties[] = [
		{
			displayName: "Secret Key",
			name: "secretKey",
			type: "string",
			typeOptions: { password: true },
			required: true,
			default: "",
			placeholder: "nsec1…",
			description:
				"The agent's Nostr secret key, as nsec1… or 64 hex characters. Anyone who holds it can act as this agent. Create one with `agx identity new` and print it with `agx identity export --yes`.",
		},
		{
			displayName: "Relays",
			name: "relays",
			type: "string",
			required: true,
			default: "",
			placeholder: "wss://relay.example.com, wss://relay2.example.com",
			description:
				"Relays this agent reads its inbox from and publishes to, separated by commas. Agents exchange tasks through relays they share, or that they advertise on their cards.",
		},
		{
			displayName: "Organization",
			name: "org",
			type: "string",
			default: "",
			description: "Name shown on the Agent Card, when this agent advertises one",
		},
		{
			displayName: "NIP-05 Address",
			name: "nip05",
			type: "string",
			default: "",
			placeholder: "agent@example.com",
			description:
				"Domain identity claimed on the Agent Card. Peers trust it only if https://<domain>/.well-known/nostr.json maps the name to this agent's public key.",
		},
	];
}
