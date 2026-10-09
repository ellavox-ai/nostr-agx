import { describe, expect, it, vi } from "vitest";
import { browserCommand, openBrowser, shouldOpenBrowser } from "./browser.js";

const desktop = {
	env: {} as NodeJS.ProcessEnv,
	platform: "darwin" as NodeJS.Platform,
	stderrIsTTY: true,
};

describe("shouldOpenBrowser", () => {
	it("opens for a person at a desktop terminal", () => {
		expect(shouldOpenBrowser(desktop)).toBe(true);
		expect(shouldOpenBrowser({ ...desktop, platform: "linux", env: { DISPLAY: ":0" } })).toBe(true);
		expect(shouldOpenBrowser({ ...desktop, platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } })).toBe(true);
		expect(shouldOpenBrowser({ ...desktop, platform: "win32" })).toBe(true);
		// A local ssh-agent is not an SSH session.
		expect(shouldOpenBrowser({ ...desktop, env: { SSH_AUTH_SOCK: "/tmp/agent" } })).toBe(true);
	});

	it.each([
		["--no-browser", { browser: false }],
		["--json", { json: true }],
		["--no-wait", { wait: false }],
		["CI", { env: { CI: "true" } }],
		["AGX_NO_BROWSER", { env: { AGX_NO_BROWSER: "1" } }],
		["SSH_CONNECTION", { env: { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" } }],
		["SSH_CLIENT", { env: { SSH_CLIENT: "1.2.3.4 5 22" } }],
		["SSH_TTY", { env: { SSH_TTY: "/dev/pts/1" } }],
		["Linux without a display", { platform: "linux" as NodeJS.Platform }],
		["a non-TTY stderr", { stderrIsTTY: false }],
	])("never under %s", (_label, patch) => {
		expect(shouldOpenBrowser({ ...desktop, ...patch })).toBe(false);
	});
});

describe("openBrowser", () => {
	const base = "https://app.ellaworks.ai";
	const url = `${base}/auth/device?code=WDJB-MJHT`;

	function spawner() {
		const child = { unref: vi.fn(), on: vi.fn() };
		const spawn = vi.fn(() => child);
		return { spawn, child };
	}

	it.each([
		["darwin", "open", [url]],
		["linux", "xdg-open", [url]],
		["win32", "rundll32", ["url.dll,FileProtocolHandler", url]],
	] as const)("%s: %s with an argv array, no shell, detached", (platform, command, args) => {
		const { spawn, child } = spawner();
		expect(openBrowser(url, base, { platform, spawn })).toBe(true);
		expect(spawn).toHaveBeenCalledWith(command, args, {
			detached: true,
			stdio: "ignore",
			shell: false,
		});
		expect(child.unref).toHaveBeenCalled();
		expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
		expect(browserCommand(url, platform)?.command).toBe(command);
	});

	it("passes shell metacharacters through as one inert argument", () => {
		const { spawn } = spawner();
		const tricky = `${base}/auth/device?code=$(rm -rf ~)&x=\`id\`;echo`;
		openBrowser(tricky, base, { platform: "darwin", spawn });
		const calls = spawn.mock.calls as unknown as Array<[string, string[]]>;
		expect(calls[0]?.[1]).toHaveLength(1);
		expect(calls[0]?.[1][0]).toBe(new URL(tricky).toString());
	});

	it.each([
		"https://evil.example/auth/device",
		"http://app.ellaworks.ai/auth/device",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"not a url",
	])("never opens %s", (target) => {
		const { spawn } = spawner();
		expect(openBrowser(target, base, { platform: "darwin", spawn })).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("swallows a spawn failure", () => {
		const spawn = vi.fn(() => {
			throw new Error("ENOENT");
		});
		expect(openBrowser(url, base, { platform: "linux", spawn })).toBe(false);
	});
});
