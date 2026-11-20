import { AgxCliError, EXIT } from "../errors.js";

/** Only the SDK surface the CLI uses. Imported as types so no Tailscale code is
 * loaded until a Tailscale-enabled command actually needs it. */
export type TailscaleSdk = typeof import("@nostr-agx/tailscale");

export type TailscaleRelayConfig = NonNullable<
	Parameters<TailscaleSdk["startTailscaleRelayProxy"]>[0]
>;
export type TailscaleStarter = NonNullable<TailscaleRelayConfig["start"]>;
export type TailscaleErrorCode =
	TailscaleSdk["TailscaleError"] extends new (
		code: infer C,
		...args: never[]
	) => Error
		? C
		: never;
export type TailscaleOAuthOptions = Parameters<
	TailscaleSdk["oauthAuthKey"]
>[0];

/** Same value as the SDK's constant, duplicated so the common CLI path does not
 * have to load the optional package just to print status. */
export const DEFAULT_TAILSCALE_OAUTH_TAGS = ["tag:agx-agent"] as const;

let sdkPromise: Promise<TailscaleSdk> | undefined;
let loaderOverride: (() => Promise<TailscaleSdk>) | undefined;

/** Tests replace the package loader to simulate a missing/optional dependency. */
export function setTailscaleSdkLoaderForTests(
	loader?: () => Promise<TailscaleSdk>,
): () => void {
	const previous = loaderOverride;
	loaderOverride = loader;
	return () => {
		loaderOverride = previous;
	};
}

/**
 * Load the Tailscale SDK only when Tailscale is actually used. Keeping this as
 * a dynamic import (and an optional peer dependency) means installing agx does
 * not pull in the SDK's ~100MB of bundled platform binaries.
 */
function missingSdkError(cause: unknown): AgxCliError {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return new AgxCliError("Tailscale support is not installed.", {
		exitCode: EXIT.config,
		remediation:
			"Install the optional package alongside agx, then retry. For a global install:\n    npm install -g @nostr-agx/cli @nostr-agx/tailscale\nThe package was not found because: " +
			detail,
	});
}

export async function loadTailscaleSdk(): Promise<TailscaleSdk> {
	if (loaderOverride) {
		return loaderOverride().catch((cause: unknown) => {
			throw missingSdkError(cause);
		});
	}
	sdkPromise ??= import("@nostr-agx/tailscale").catch((cause: unknown) => {
		sdkPromise = undefined;
		throw missingSdkError(cause);
	});
	return sdkPromise;
}

/** `TailscaleError` is loaded from the SDK at runtime, so the CLI cannot use
 * `instanceof` on it without defeating optional loading. Recognise its stable
 * shape instead; unknown errors keep the CLI's generic error path. */
export function isTailscaleError(
	error: unknown,
): error is Error & { code: TailscaleErrorCode; remediation?: string } {
	if (!(error instanceof Error) || error.name !== "TailscaleError") {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return (
		code === "configuration" ||
		code === "auth" ||
		code === "network" ||
		code === "module"
	);
}
