/**
 * Shared AGX half of the Tailscale examples. Both examples only differ in how
 * they obtain an auth key; the reviewer/requester exchange lives here so the
 * two stay in sync.
 */
import { AgxClient } from "@nostr-agx/core";
import { generateKeypair, localSigner, NostrTransport } from "@nostr-agx/nostr";
import WebSocket from "ws";

export function requiredRelay(relay: string | undefined): string {
	if (!relay) {
		throw new Error("Pass --relay wss://... or set AGX_RELAY.");
	}
	let url: URL;
	try {
		url = new URL(relay);
	} catch {
		throw new Error(`The relay is not a URL: ${relay}`);
	}
	if (url.protocol !== "wss:" && url.protocol !== "ws:") {
		throw new Error(`The relay must be a ws:// or wss:// URL, got ${url.protocol}`);
	}
	return relay;
}

/**
 * The error for an argument an example does not know. A key or secret can land
 * in an argument by mistake (`--authkey=<key>`, a value typed after a flag that
 * takes none), so this names an option but never repeats what follows its `=`,
 * and repeats nothing of an argument that is not an option.
 */
export function unknownArgument(arg: string): Error {
	const help = "Run with --help to see the options.";
	if (!arg.startsWith("--")) {
		return new Error(`Unknown argument (its text is not shown, in case it is a key or secret). ${help}`);
	}
	const [name] = arg.split("=", 1);
	return new Error(
		name === arg
			? `Unknown option ${name}. ${help}`
			: `Unknown option ${name} (the value after "=" is not shown). ${help}`,
	);
}

/** Run one reviewer/requester pair over a borrowed Tailscale proxy URL. */
export async function runAgents(options: {
	relay: string;
	relayProxy: string;
}): Promise<void> {
	let reviewer: AgxClient | undefined;
	let requester: AgxClient | undefined;
	try {
		const reviewerKey = generateKeypair();
		const requesterKey = generateKeypair();
		const shared = {
			relays: [options.relay],
			ws: WebSocket,
			relayProxy: options.relayProxy,
		};

		reviewer = new AgxClient({
			transport: await NostrTransport.create({
				...shared,
				signer: localSigner(reviewerKey.secretKey),
			}),
			identity: { org: "Tailscale example — invoice desk" },
			// Default-deny: only the requester in this process may invoke the handler.
			authorize: ({ from }) => from === requesterKey.publicKey,
		});
		reviewer.handle<{ amount: number; vendor: string }, { approved: boolean }>(
			"invoice.review",
			async (task) => {
				console.info("reviewer  task →", task.payload);
				return { approved: task.payload.amount < 10_000 };
			},
		);

		requester = new AgxClient({
			transport: await NostrTransport.create({
				...shared,
				signer: localSigner(requesterKey.secretKey),
			}),
		});

		await Promise.all([
			reviewer.start({ pollIntervalMs: 250 }),
			requester.start({ pollIntervalMs: 250 }),
		]);
		const stream = await requester.streamRequest<{ approved: boolean }>(
			reviewer.whoami(),
			"invoice.review",
			{ amount: 4200, vendor: "Globex" },
		);
		stream.on("error", (error) => console.error("task error →", error));
		stream.on("statusUpdate", (status) =>
			console.info("task status →", status),
		);
		console.info("task result →", await stream.result);
	} finally {
		await Promise.all([requester?.stop(), reviewer?.stop()]);
	}
}
