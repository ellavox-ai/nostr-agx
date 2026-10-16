import { type SpawnOptions, spawn } from "node:child_process";

/**
 * Opening the verification page for the person at the keyboard, and only then.
 *
 * Never under `--json`, `--no-wait`, CI, over SSH, on a Linux box with no
 * display, or when stderr is not a terminal: in all of those there is either
 * no person at this screen or a harness relaying the URL itself. The URL is
 * always printed as well, so not opening a browser never blocks anyone.
 */

export interface BrowserDecisionInput {
	/** `false` under `--no-browser`. */
	browser?: boolean;
	json?: boolean;
	/** `false` under `--no-wait`. */
	wait?: boolean;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	stderrIsTTY?: boolean;
}

export function shouldOpenBrowser(input: BrowserDecisionInput): boolean {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	const stderrIsTTY = input.stderrIsTTY ?? Boolean(process.stderr.isTTY);
	if (input.browser === false || input.json || input.wait === false) {
		return false;
	}
	if (env.CI || env.AGX_NO_BROWSER) {
		return false;
	}
	// The variables sshd sets for a session. Not SSH_AUTH_SOCK, which a local
	// desktop agent sets too.
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
		return false;
	}
	if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
		return false;
	}
	return stderrIsTTY;
}

/** The argv that opens `url` in the default browser. No shell is involved, so
 * nothing in the URL is ever interpreted. */
export function browserCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | null {
	switch (platform) {
		case "darwin":
			return { command: "open", args: [url] };
		case "win32":
			return {
				command: "rundll32",
				args: ["url.dll,FileProtocolHandler", url],
			};
		case "linux":
		case "freebsd":
		case "openbsd":
			return { command: "xdg-open", args: [url] };
		default:
			return null;
	}
}

type Spawner = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => { unref(): void; on(event: "error", listener: () => void): unknown };

/**
 * Open `url` if, and only if, it is http(s) on `base`'s origin. Returns
 * whether a browser was launched. Errors are swallowed: the caller has already
 * printed the URL.
 */
export function openBrowser(
	url: string,
	base: string,
	options?: { platform?: NodeJS.Platform; spawn?: Spawner },
): boolean {
	let target: URL;
	try {
		target = new URL(url);
		if (
			(target.protocol !== "https:" && target.protocol !== "http:") ||
			target.origin !== new URL(base).origin
		) {
			return false;
		}
	} catch {
		return false;
	}
	const command = browserCommand(target.toString(), options?.platform);
	if (!command) {
		return false;
	}
	try {
		const child = (options?.spawn ?? (spawn as unknown as Spawner))(
			command.command,
			command.args,
			{ detached: true, stdio: "ignore", shell: false },
		);
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
