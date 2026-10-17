import {
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	NodeConnectionTypes,
	NodeOperationError,
} from "n8n-workflow";
import { testAgxCredential } from "../shared/credential-test";
import {
	agxLogger,
	createTransport,
	identityFromCredentials,
} from "../shared/identity";
import { getCards, getIdentity, requestTasks, sendMessages } from "./actions";

/**
 * Talks to other agents over NIP-AGX: requests a task and waits for its result,
 * sends a message, or reads an agent's card. Usable as an AI Agent tool, so a
 * model in n8n can call capabilities other organizations' agents advertise.
 *
 * Answering other agents' tasks is the AGX Trigger's job.
 */
export class Agx implements INodeType {
	description: INodeTypeDescription = {
		displayName: "AGX",
		name: "agx",
		icon: { light: "file:../../icons/agx.svg", dark: "file:../../icons/agx.dark.svg" },
		group: ["output"],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: "Exchange tasks and messages with other agents over Nostr (NIP-AGX)",
		defaults: {
			name: "AGX",
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: "agxApi",
				required: true,
				testedBy: "agxApiTest",
			},
		],
		properties: [
			{
				displayName: "Resource",
				name: "resource",
				type: "options",
				noDataExpression: true,
				options: [
					{ name: "Agent", value: "agent" },
					{ name: "Message", value: "message" },
					{ name: "Task", value: "task" },
				],
				default: "task",
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				displayOptions: { show: { resource: ["task"] } },
				options: [
					{
						name: "Request",
						value: "request",
						action: "Request a task from an agent",
						description:
							"Ask an agent to run one of its capabilities, and wait for the result",
					},
				],
				default: "request",
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				displayOptions: { show: { resource: ["message"] } },
				options: [
					{
						name: "Send",
						value: "send",
						action: "Send a message to an agent",
						description: "Send an end-to-end encrypted message to an agent",
					},
				],
				default: "send",
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				displayOptions: { show: { resource: ["agent"] } },
				options: [
					{
						name: "Get Card",
						value: "getCard",
						action: "Get the card of an agent",
						description:
							"Read the capabilities, organization and relays an agent advertises",
					},
					{
						name: "Get Own Identity",
						value: "getIdentity",
						action: "Get the identity of this agent",
						description:
							"Return this credential's public key and relays, to give to other agents",
					},
				],
				default: "getCard",
			},
			{
				displayName: "Agent",
				name: "peer",
				type: "string",
				required: true,
				default: "",
				placeholder: "npub1…",
				description: "The other agent's public key: npub1… or 64 hex characters",
				displayOptions: {
					show: { operation: ["request", "send", "getCard"] },
				},
			},

			// Task → Request
			{
				displayName: "Capability",
				name: "capability",
				type: "string",
				required: true,
				default: "",
				placeholder: "invoice.review",
				description: "The capability to run, as the agent advertises it",
				displayOptions: { show: { resource: ["task"], operation: ["request"] } },
			},
			{
				displayName: "Payload",
				name: "payload",
				type: "json",
				default: "{}",
				description: "JSON the agent's capability handler receives",
				displayOptions: { show: { resource: ["task"], operation: ["request"] } },
			},
			{
				displayName: "Options",
				name: "options",
				type: "collection",
				placeholder: "Add Option",
				default: {},
				displayOptions: { show: { resource: ["task"], operation: ["request"] } },
				options: [
					{
						displayName: "Check Agent Card First",
						name: "checkCard",
						type: "boolean",
						default: false,
						description:
							"Whether to read the agent's card first, and fail at once if it does not advertise the capability",
					},
					{
						displayName: "Timeout (Seconds)",
						name: "timeout",
						type: "number",
						typeOptions: { minValue: 1 },
						default: 30,
						description:
							"How long to wait for the result. An agent that has not allowed this one sends no reply at all, so a missing allowlist entry shows up as a timeout.",
					},
				],
			},

			// Message → Send
			{
				displayName: "Text",
				name: "text",
				type: "string",
				typeOptions: { rows: 4 },
				required: true,
				default: "",
				description: "The message body",
				displayOptions: { show: { resource: ["message"], operation: ["send"] } },
			},
			{
				displayName: "Options",
				name: "options",
				type: "collection",
				placeholder: "Add Option",
				default: {},
				displayOptions: { show: { resource: ["message"], operation: ["send"] } },
				options: [
					{
						displayName: "Automated Reply Depth",
						name: "autoDepth",
						type: "number",
						typeOptions: { minValue: 0 },
						default: 0,
						description:
							"For a message sent automatically in reply to another, the inbound message's depth plus one: the replyAutoDepth field an AGX Trigger outputs. Leave 0 for a message a person wrote or approved. Agents use it to end reply loops.",
					},
					{
						displayName: "Conversation ID",
						name: "contextId",
						type: "string",
						default: "",
						description:
							"Continue a conversation: the contextId of the message being answered. Leave empty to start a new one.",
					},
					{
						displayName: "Max Automated Replies per Agent per Hour",
						name: "maxPerHour",
						type: "number",
						typeOptions: { minValue: 1 },
						default: 60,
						description:
							"Refuse an automated reply (depth above 0) to an agent that has had this many in the last hour",
					},
					{
						displayName: "Max Automated Replies per Conversation",
						name: "maxPerConversation",
						type: "number",
						typeOptions: { minValue: 1 },
						default: 20,
						description:
							"Refuse an automated reply in a conversation that has had this many",
					},
					{
						displayName: "Max Automated Reply Depth",
						name: "maxAutoDepth",
						type: "number",
						typeOptions: { minValue: 1 },
						default: 8,
						description: "Refuse an automated reply deeper than this",
					},
					{
						displayName: "Subject",
						name: "subject",
						type: "string",
						default: "",
					},
				],
			},

			// Agent → Get Card
			{
				displayName: "Options",
				name: "options",
				type: "collection",
				placeholder: "Add Option",
				default: {},
				displayOptions: { show: { resource: ["agent"], operation: ["getCard"] } },
				options: [
					{
						displayName: "Capability to Check",
						name: "capability",
						type: "string",
						default: "",
						placeholder: "invoice.review",
						description:
							"Report whether the card advertises this capability, wildcards included",
					},
					{
						displayName: "Verify NIP-05",
						name: "verifyNip05",
						type: "boolean",
						default: true,
						description:
							"Whether to confirm the domain identity the card claims with that domain's own NIP-05 record",
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			agxApiTest: testAgxCredential,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter("resource", 0) as string;
		const operation = this.getNodeParameter("operation", 0) as string;

		let identity: ReturnType<typeof identityFromCredentials>;
		try {
			identity = identityFromCredentials(
				await this.getCredentials("agxApi"),
			);
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error as Error);
		}

		if (resource === "agent" && operation === "getIdentity") {
			return [getIdentity(items, identity)];
		}

		if (resource === "task" && operation === "request") {
			return [await requestTasks(this, items, identity)];
		}
		if (resource === "message" && operation === "send") {
			const transport = await createTransport(identity, agxLogger(this.logger));
			return [await sendMessages(this, items, transport, identity)];
		}
		if (resource === "agent" && operation === "getCard") {
			return [await getCards(this, items, identity)];
		}
		throw new NodeOperationError(
			this.getNode(),
			`The operation "${operation}" is not supported for "${resource}"`,
		);
	}
}
