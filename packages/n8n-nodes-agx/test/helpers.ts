import { AgxClient } from "@nostr-agx/core";
import {
	bytesToHex,
	generateKeypair,
	localSigner,
	NostrTransport,
} from "@nostr-agx/nostr";
import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	IRun,
	ITriggerFunctions,
	Logger,
} from "n8n-workflow";
// The CLI's in-process NIP-01 relay: plain ws on a random loopback port.
import { type RunningRelay, startRelay } from "../../cli/src/relay/server";

export type { RunningRelay };

export function startTestRelay(): Promise<RunningRelay> {
	return startRelay({ port: 0 });
}

export function relayUrl(relay: RunningRelay): string {
	return `ws://127.0.0.1:${relay.port}`;
}

/** A fresh agent: its key pair, and the credential data an n8n user would enter. */
export function newAgent(relay: RunningRelay) {
	const keys = generateKeypair();
	return {
		...keys,
		credentials: {
			secretKey: bytesToHex(keys.secretKey),
			relays: relayUrl(relay),
			org: "",
			nip05: "",
		} as ICredentialDataDecryptedObject,
	};
}

/** A plain `AgxClient` on the relay — the agent on the other side of a test. */
export async function peerClient(
	relay: RunningRelay,
	agent: { secretKey: Uint8Array },
	options: Partial<ConstructorParameters<typeof AgxClient>[0]> = {},
): Promise<AgxClient> {
	const transport = await NostrTransport.create({
		signer: localSigner(agent.secretKey),
		relays: [relayUrl(relay)],
	});
	return new AgxClient({
		transport,
		startCursor: Math.floor(Date.now() / 1000),
		...options,
	});
}

export const quietLogger: Logger = {
	error: () => undefined,
	warn: () => undefined,
	info: () => undefined,
	debug: () => undefined,
};

const NODE: INode = {
	id: "test-node",
	name: "AGX",
	type: "@nostr-agx/n8n-nodes-agx.agx",
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** The slice of n8n's `IExecuteFunctions` the AGX node uses. `params` gives
 * each item's parameters. */
export function executeContext(opts: {
	credentials: ICredentialDataDecryptedObject;
	params: (itemIndex: number) => IDataObject;
	items?: number;
	continueOnFail?: boolean;
}): IExecuteFunctions {
	const items: INodeExecutionData[] = Array.from(
		{ length: opts.items ?? 1 },
		() => ({ json: {} }),
	);
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) =>
			opts.params(itemIndex)[name] ?? fallback,
		getCredentials: async () => opts.credentials,
		getNode: () => NODE,
		continueOnFail: () => opts.continueOnFail ?? false,
		logger: quietLogger,
	};
	return ctx as unknown as IExecuteFunctions;
}

export interface Emitted {
	json: IDataObject;
	done?: { resolve: (run: IRun) => void; reject: (error: Error) => void };
}

/** The slice of n8n's `ITriggerFunctions` the AGX Trigger uses. Every emit is
 * recorded; a test settles a task's done-promise with {@link finishedRun}. */
export function triggerContext(opts: {
	credentials: ICredentialDataDecryptedObject;
	params: IDataObject;
	mode?: "trigger" | "manual";
	/** n8n's reason for starting an active trigger: "init" on startup,
	 * "update" on a save, "activate" when the workflow is turned on. */
	activationMode?: "init" | "update" | "activate";
	staticData?: IDataObject;
	/** Identifies the trigger node; one id per test keeps tests apart. */
	workflowId?: string;
}) {
	const emitted: Emitted[] = [];
	const staticData = opts.staticData ?? {};
	const workflowId = opts.workflowId ?? `wf-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		getNodeParameter: (name: string, fallback?: unknown) =>
			opts.params[name] ?? fallback,
		getCredentials: async () => opts.credentials,
		getNode: () => ({ ...NODE, id: "trigger-node", name: "AGX Trigger" }),
		getWorkflow: () => ({ id: workflowId, active: opts.mode !== "manual" }),
		getMode: () => opts.mode ?? "trigger",
		getActivationMode: () =>
			opts.mode === "manual" ? "manual" : (opts.activationMode ?? "init"),
		getWorkflowStaticData: () => staticData,
		logger: quietLogger,
		helpers: {
			createDeferredPromise: <T>() => {
				let resolve!: (value: T) => void;
				let reject!: (error: Error) => void;
				const promise = new Promise<T>((res, rej) => {
					resolve = res;
					reject = rej;
				});
				return { promise, resolve, reject };
			},
		},
		emit: (
			data: INodeExecutionData[][],
			_response?: unknown,
			done?: Emitted["done"],
		) => {
			emitted.push({ json: data[0][0].json, done });
		},
	};
	return { ctx: ctx as unknown as ITriggerFunctions, emitted, staticData, workflowId };
}

/** An n8n execution that finished with `items` out of its last node — or
 * failed with `error`. */
export function finishedRun(items: IDataObject[], error?: string): IRun {
	return {
		data: {
			version: 1,
			resultData: {
				runData: {
					Last: [
						{
							startTime: 0,
							executionIndex: 0,
							executionTime: 1,
							source: [],
							data: { main: [items.map((json) => ({ json }))] },
						},
					],
				},
				lastNodeExecuted: "Last",
				...(error ? { error: { message: error } } : {}),
			},
		},
		mode: "trigger",
		startedAt: new Date(),
		storedAt: "db",
		status: error ? "error" : "success",
	} as unknown as IRun;
}

/** Wait until `check` returns a value, polling every 100 ms. */
export async function waitFor<T>(
	check: () => T | undefined | false | Promise<T | undefined | false>,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Pump `clients` until `promise` settles: a test's stand-in for `start()`. */
export async function pumpUntil<T>(
	promise: Promise<T>,
	clients: AgxClient[],
): Promise<T> {
	let settled = false;
	const watched = promise.finally(() => {
		settled = true;
	});
	watched.catch(() => undefined);
	while (!settled) {
		for (const client of clients) {
			await client.pump();
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return watched;
}
