/**
 * Agent 2 of 2 — the requester (initiator). Discovers the reviewer's Agent
 * Card over the relay, opens a STREAMING task request, and answers the
 * reviewer's mid-task questions with its own LOCAL LLM, reasoning over its
 * private purchasing notes. That is the other half of the input-required
 * workflow between two agents: two processes, two models, every question and
 * answer a signed encrypted Nostr event through the relay.
 *
 *   node examples/two-agents/requester.mjs      # from packages/nostr, after pnpm build
 *
 * The LLM server is configured by llm.mjs (AGX_LLM_BASE_URL, AGX_LLM_MODEL).
 * With no server reachable, no model installed on it, or a model call failing
 * mid-task, this agent says so and answers from a fixed canned policy instead
 * — the logs and the task result say which decided (`llm:<model>` or
 * `canned-fallback`), so nobody mistakes a stub answer for a model's.
 *
 * Needs the relay and the reviewer running first. This agent exits after one
 * task; run it again while the reviewer stays up to repeat the exchange.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgxClient } from "@nostr-agx/core";
import {
	hexToBytes,
	localSigner,
	NostrTransport,
	resolvePeerCard,
} from "@nostr-agx/nostr";
import WebSocket from "ws";
import { chat, resolveLlmSetup } from "./llm.mjs";

const RELAY = process.env.AGX_RELAY ?? "ws://127.0.0.1:7447";
/** Overall task budget: several input-required rounds, each possibly waiting
 * on a local model (which may be cold-loading). */
const TASK_TIMEOUT_MS = 360_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadAgent(name) {
	const file = fileURLToPath(
		new URL(`./.two-agents/${name}.json`, import.meta.url),
	);
	return JSON.parse(readFileSync(file, "utf8"));
}

const clock = () => new Date().toISOString().slice(11, 23);
const short = (pubkey) => `${pubkey.slice(0, 10)}…${pubkey.slice(-6)}`;
const log = (line) => console.log(`${clock()}  requester  ${line}`);

const me = loadAgent("requester");
const peer = loadAgent("reviewer");

/**
 * This agent's private context — the purchasing department's records. In a
 * real agent this is a database, a document store, or the host's context; the
 * model never gets the reviewer's prompts about it, and the reviewer never
 * sees it — only the answers the model chooses to send.
 */
const NOTES = `Purchasing notes (internal):
- INV-8891, Globex, $4,200 — Q4 cloud infrastructure renewal under contract V-8891.
  Budget code INFRA-Q4, already reserved. Vendor confirmed delivery Dec 18.
- Policy: purchases under $5,000 with a reserved budget code may be confirmed
  by us directly; above that, escalate to the finance lead.
- Globex is a preferred vendor since 2024, no open disputes.`;

const transport = await NostrTransport.create({
	signer: localSigner(hexToBytes(me.secretHex)),
	relays: [RELAY],
	ws: WebSocket,
});
const client = new AgxClient({
	transport,
	// Multi-turn task: enough time for every question and answer to travel.
	requestTimeoutMs: TASK_TIMEOUT_MS,
});

// Startup model check: a reachable server is not enough — the model must be
// installed, or every completion would 404 (Ollama: "model not found").
const llm = await resolveLlmSetup(log);
// Set when a model call fails mid-task: that answer degrades to the canned
// policy instead of killing the conversation, and its label says so.
let llmDegraded = false;

// --- 1. Discover the peer before sending anything ------------------------
// What `agx card <npub>` does from the CLI: read the reviewer's signed Agent
// Card off the relay and check it advertises the capability we want.
let card = null;
for (let attempt = 0; attempt < 5 && !card; attempt += 1) {
	// A lookup made outside the transport needs the WebSocket class too: Node 20
	// has no global one, and without it the lookup finds nothing.
	card = await resolvePeerCard(peer.publicKey, [RELAY], undefined, WebSocket);
	if (!card) {
		log(`waiting for the reviewer's Agent Card… (${attempt + 1}/5)`);
		await sleep(1_000);
	}
}
if (!card) {
	log(`no Agent Card found for ${short(peer.publicKey)} — requesting anyway`);
} else {
	log(
		`peer card: "${card.displayName ?? "anonymous"}"  capabilities [${card.capabilities.join(", ")}]`,
	);
	if (!card.capabilities.includes("invoice.review")) {
		log("the reviewer does not advertise invoice.review — stopping");
		process.exit(1);
	}
}

// --- 2. Request work, streaming: expect to be asked for input -------------
await client.start({ pollIntervalMs: 200, advertise: false });
const stream = await client.streamRequest(
	peer.publicKey,
	"invoice.review",
	{ amount: 5000, vendor: "Globex", invoiceId: "INV-8891" },
	{ timeoutMs: TASK_TIMEOUT_MS },
);

stream.on("statusUpdate", (status) => log(`task status → ${status}`));
stream.on("error", (error) => log(`task error → ${error}`));

/**
 * The agent's decision loop: answer the reviewer's question with the local
 * model, from this agent's own notes. Boolean questions (the reviewer's
 * confirmation round) come back as a strict yes/no.
 */
async function decide(requirement) {
	const question = requirement.prompt;
	const isBoolean = requirement.inputSchema?.type === "boolean";
	const cannedAnswer = isBoolean
		? true
		: "Q4 cloud infrastructure renewal";
	const cannedBecause = isBoolean
		? "canned policy: amount inside the confirm band"
		: "canned policy: notes name INV-8891";
	if (!llm.ready) {
		return {
			answer: cannedAnswer,
			because: cannedBecause,
			decidedBy: "canned-fallback",
		};
	}
	let raw;
	try {
		raw = await chat(
			[
				{
					role: "system",
					content: isBoolean
						? "You answer on behalf of the requesting company's purchasing agent. Reply with exactly YES or NO and nothing else."
						: "You answer on behalf of the requesting company's purchasing agent, using ONLY the notes provided. Reply in one short sentence.",
				},
				{
					role: "user",
					content: `${NOTES}\n\nThe invoice reviewer asks: "${question}"`,
				},
			],
			{ model: llm.model },
		);
	} catch (error) {
		llmDegraded = true;
		log(
			`model call failed → ${error?.message ?? String(error)} — answering from the canned policy instead`,
		);
		return {
			answer: cannedAnswer,
			because: `${cannedBecause} (an llm call failed — see above)`,
			decidedBy: "canned-fallback (llm call failed)",
		};
	}
	log(`model says → ${raw.split("\n")[0].slice(0, 120)}`);
	const answer = isBoolean ? /^yes\b/i.test(raw) : raw.split("\n")[0].trim();
	return {
		answer,
		because: isBoolean
			? "per purchasing policy in notes"
			: "from this agent's purchasing notes",
		decidedBy: `llm:${llm.model}`,
	};
}

// An input-required update is nonterminal: the request stays open, and this
// agent answers through the SAME task with stream.provideInput().
stream.on("inputRequired", (update) => {
	void (async () => {
		log(`peer asks: "${update.requirement.prompt}"`);
		const decision = await decide(update.requirement);
		log(
			`answer: ${JSON.stringify(decision.answer)} — ${decision.because} [${decision.decidedBy}]`,
		);
		await stream.provideInput(update.inputRequestId, decision.answer);
		log("answer sent");
	})().catch((error) => {
		log(`could not answer: ${error?.message ?? String(error)}`);
		process.exit(1);
	});
});

process.on("SIGINT", () => process.exit(130));

// --- 3. Wait for the final result ----------------------------------------
const result = await stream.result;
log("final result →");
console.log(JSON.stringify(result, null, 2));
await client.stop();
process.exit(0);
