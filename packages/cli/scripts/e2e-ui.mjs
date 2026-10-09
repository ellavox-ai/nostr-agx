#!/usr/bin/env node
/**
 * Browser smoke test of `agx ui` against the built CLI and the CLI's own dev relay.
 *
 *   hold -> allow, a peer body XSS corpus that must render as inert text,
 *   axe on every view in light and dark, and Compose -> Send -> the peer
 *   receives the byte-identical text.
 *
 * The UI runs on the real message store: mail reaches it through the relay and
 * `agx send`, and the held, allow and send flows go through the same code as
 * `agx inbox` and `agx held`. No network: temp AGX_HOME, relay on a free localhost port, everything removed at the end.
 *
 *   pnpm build && pnpm --filter @nostr-agx/cli test:e2e:ui
 *
 * Needs a Playwright Chromium (`pnpm exec playwright install chromium`), or
 * point AGX_UI_CHROMIUM at a Chrome/Chromium binary.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGX = join(root, "dist", "agx.js");
const home = mkdtempSync(join(tmpdir(), "agx-e2e-ui-"));
/** @type {import("node:child_process").ChildProcess[]} */
const live = [];
let relayUrl = "";

const SEND_BODY = 'Ünïcode ✓ "quotes" <b>not bold</b> & more — sent from the UI';
const XSS = [
	'<img src=x onerror="window.__xss=1">',
	"<script>window.__xss=1</script>",
	'<svg onload="window.__xss=1"></svg>',
	"[click](javascript:window.__xss=1)",
	'"><iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
	'<a href="http://evil.example/">http://evil.example/</a>',
	"javascript:window.__xss=1",
	"<style>body{display:none}</style>",
];

class E2eFailure extends Error {}

function fail(message, output) {
	throw new E2eFailure(output ? `${message}\n----- output -----\n${output}\n------------------` : message);
}
function step(title) {
	console.log(`\n== ${title}`);
}
function pass(message) {
	console.log(`   ok  ${message}`);
}
function sleep(ms) {
	return new Promise((done) => setTimeout(done, ms));
}

function env() {
	const next = { ...process.env, NO_COLOR: "1" };
	delete next.FORCE_COLOR;
	for (const key of Object.keys(next)) {
		if (key.startsWith("AGX_")) {
			delete next[key];
		}
	}
	next.AGX_HOME = home;
	return next;
}

function agx(args, { timeoutMs = 30_000 } = {}) {
	return new Promise((done) => {
		const child = spawn(process.execPath, [AGX, ...args], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
		live.push(child);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += c;
		});
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code: code ?? 1, stdout, stderr });
		});
	});
}

async function agxOk(args) {
	const res = await agx(args);
	if (res.code !== 0) {
		fail(`agx ${args.join(" ")} exited ${res.code}`, `${res.stdout}${res.stderr}`);
	}
	return res;
}

function agxBackground(args) {
	const child = spawn(process.execPath, [AGX, ...args], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
	live.push(child);
	const handle = { child, stdout: "", stderr: "", exited: false };
	child.stdout.on("data", (c) => {
		handle.stdout += c;
	});
	child.stderr.on("data", (c) => {
		handle.stderr += c;
	});
	child.on("close", () => {
		handle.exited = true;
	});
	return handle;
}

async function waitFor(predicate, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await sleep(100);
	}
	fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** SIGTERM, then SIGKILL if the process does not exit. */
async function stop(handle) {
	if (handle.exited) {
		return;
	}
	handle.child.kill("SIGTERM");
	const deadline = Date.now() + 12_000;
	while (!handle.exited && Date.now() < deadline) {
		await sleep(100);
	}
	if (!handle.exited) {
		handle.child.kill("SIGKILL");
	}
}

function freePort() {
	return new Promise((done, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => done(port));
		});
	});
}

function lastJson(stdout) {
	const start = stdout.lastIndexOf("\n{");
	return JSON.parse(stdout.slice(start === -1 ? 0 : start).trim());
}

async function makeProfile(name) {
	await agxOk(["--profile", name, "identity", "new"]);
	await agxOk(["--profile", name, "config", "set", "relays", relayUrl]);
	const shown = await agxOk(["--profile", name, "--json", "identity", "show"]);
	return lastJson(shown.stdout).npub;
}

const VIEWS = ["inbox", "sent", "threads", "held", "peers", "compose", "identity"];

async function assertInert(page, where) {
	const state = await page.evaluate(() => ({
		fired: window.__xss ?? null,
		injected: document.querySelectorAll("main img, main iframe, main svg, main script, main style, main a[href]").length,
	}));
	if (state.fired !== null || state.injected !== 0) {
		fail(`peer text was not inert on ${where}: ${JSON.stringify(state)}`);
	}
}

async function main() {
	if (!existsSync(AGX)) {
		fail(`${AGX} is missing; build first: pnpm build`);
	}

	step("setup: dev relay, alice (UI user), bob (peer), mallory (stranger)");
	const port = await freePort();
	relayUrl = `ws://127.0.0.1:${port}`;
	const relay = agxBackground(["relay", "--port", String(port), "--no-color"]);
	await waitFor(() => relay.stdout.includes("listening") || relay.exited, 15_000, "the relay to listen");
	const alice = await makeProfile("alice");
	const bob = await makeProfile("bob");
	const mallory = await makeProfile("mallory");
	const carol = await makeProfile("carol");
	await agxOk(["--profile", "bob", "identity", "allow", alice]);
	pass(`relay ${relayUrl}`);

	// Real mail, through the relay: an allowed peer and a stranger, each with the XSS corpus.
	await agxOk(["--profile", "alice", "identity", "allow", bob]);
	await agxOk(["--profile", "alice", "identity", "allow", carol]);
	for (const [index, payload] of XSS.entries()) {
		await agxOk(["--profile", "bob", "send", "--subject", `<b>subject ${index}</b>`, "--context-id", `ctx-xss-${index}`, "--", alice, payload]);
		await agxOk(["--profile", "mallory", "send", "--subject", "<i>held</i>", "--", alice, payload]);
	}
	const ui = agxBackground(["--profile", "alice", "ui", "--no-open"]);
	await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/.test(ui.stdout) || ui.exited, 15_000, "agx ui to print its link");
	const link = ui.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/)?.[0];
	if (!link) {
		fail("agx ui did not start", `${ui.stdout}${ui.stderr}`);
	}
	pass(`ui ${link.split("?")[0]}`);

	const browser = await chromium.launch(process.env.AGX_UI_CHROMIUM ? { executablePath: process.env.AGX_UI_CHROMIUM } : {});
	try {
		const page = await (await browser.newContext()).newPage();
		const base = link.split("?")[0];
		// The way `agx ui` opens a browser by default: a local file that redirects to the one-time link.
		const launcher = join(home, "launch.html");
		writeFileSync(launcher, `<!doctype html><meta charset="utf-8"><script>location.replace(${JSON.stringify(link)})</script>`);
		await page.goto(`file://${launcher}`);
		const loggedIn = await page.waitForSelector("nav", { timeout: 10_000 }).then(() => true, () => false);
		if (!loggedIn) {
			fail("opening the link from a file:// page did not log in", await page.locator("body").innerText());
		}
		pass("one-time link opened from a file:// page; cookie set");

		const stranger = await browser.newContext();
		const replay = await (await stranger.newPage()).goto(link);
		const cookies = await stranger.cookies();
		await stranger.close();
		if (replay && replay.status() < 400 && cookies.length > 0) {
			fail("a used one-time link opened the UI in a fresh browser");
		}

		step("mail arrives through the real store, and peer text renders as inert text");
		await page.goto(`${base}#/inbox`);
		for (let attempt = 0; attempt < 40 && (await page.locator("li.row").count()) < XSS.length; attempt += 1) {
			await sleep(500);
			await page.reload();
			await page.waitForSelector("nav");
		}
		if ((await page.locator("li.row").count()) < XSS.length) {
			fail("the inbox never showed the allowed peer's messages", ui.stdout + ui.stderr);
		}
		await assertInert(page, "inbox");
		for (const payload of XSS.slice(0, 3)) {
			if ((await page.getByText(payload, { exact: false }).count()) === 0) {
				fail(`payload not shown as text: ${payload}`);
			}
		}
		await page.goto(`${base}#/thread/ctx-xss-0`);
		await page.waitForSelector(".frame, .you-text, li", { timeout: 5000 }).catch(() => undefined);
		await assertInert(page, "thread");
		await page.goto(`${base}#/held`);
		await page.waitForSelector("li.row");
		await assertInert(page, "held");
		pass(`${XSS.length} payloads inert on inbox, thread and held`);

		step("axe: every view, light and dark");
		const found = [];
		for (const scheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme: scheme });
			for (const view of VIEWS) {
				await page.goto(`${base}#/${view}`);
				await page.waitForTimeout(300);
				const results = await new AxeBuilder({ page }).analyze();
				for (const v of results.violations) {
					found.push(`${view} (${scheme}): ${v.id} (${v.impact}), ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target?.join(" ")}`);
				}
			}
		}
		if (found.length > 0) {
			fail("axe violations", found.join("\n"));
		}
		await page.emulateMedia({ colorScheme: "light" });
		pass(`${VIEWS.length} views x 2 themes: no violations`);

		step("held -> allow, without undoing a change made elsewhere");
		await agxOk(["--profile", "alice", "identity", "deny", carol]);
		await page.goto(`${base}#/held`);
		await page.getByRole("button", { name: "Allow" }).first().click();
		await page.waitForSelector("text=No held senders.");
		if (await page.locator("nav .badge").count()) {
			fail("the Held badge is still shown after allowing");
		}
		pass("sender allowed, list empty, badge gone");

		step("compose -> send -> bob receives the exact text");
		await page.goto(`${base}#/compose`);
		await page.fill("#to", bob);
		await page.fill("#subject", "From the UI");
		await page.fill("#body", SEND_BODY);
		await page.getByRole("button", { name: "Review and send" }).click();
		await page.waitForSelector("dialog[open]");
		const shown = await page.locator("dialog[open] .you-text").innerText();
		if (shown !== SEND_BODY) {
			fail(`confirmation shows different text: ${JSON.stringify(shown)}`);
		}
		await page.locator("dialog[open]").getByRole("button", { name: "Send", exact: true }).click();
		await page.waitForURL(/#\/sent/);
		pass("sent from the browser");

		let received = "";
		for (let attempt = 0; attempt < 20 && !received.includes(SEND_BODY); attempt += 1) {
			const res = await agx(["--profile", "bob", "serve", "--once", "--no-reply", "--no-tasks", "--full-ids", "--no-color"]);
			received += res.stdout;
			if (!received.includes(SEND_BODY)) {
				await sleep(250);
			}
		}
		if (!received.includes(SEND_BODY)) {
			fail("bob did not receive the byte-identical text", received);
		}
		pass("bob received the exact bytes");

		step("the UI left the profile consistent");
		await stop(ui);
		if (existsSync(join(home, "profiles", "alice", "serve.lock"))) {
			fail("the profile lock was left behind after agx ui stopped");
		}
		const allowList = await agxOk(["--profile", "alice", "identity", "allow", "--list", "--no-color"]);
		if (!allowList.stdout.includes(mallory)) {
			fail("the sender allowed in the UI is not on the profile allowlist", allowList.stdout);
		}
		if (allowList.stdout.includes(carol)) {
			fail("the UI put back a peer that was removed with `agx identity deny` while it ran", allowList.stdout);
		}
		const history = readFileSync(join(home, "profiles", "alice", "messages.jsonl"), "utf8");
		if (!history.includes(JSON.stringify(SEND_BODY).slice(1, -1))) {
			fail("the message sent from the UI is not in the history", history);
		}
		const heldAfter = lastJson((await agxOk(["--profile", "alice", "--json", "held", "list"])).stdout);
		if (heldAfter.held.length !== 0) {
			fail("the allowed sender is still held", JSON.stringify(heldAfter));
		}
		pass("lock released, allowlist updated, sent message in the history, held list empty");
	} finally {
		await browser.close();
		ui.child.kill("SIGTERM");
		relay.child.kill("SIGTERM");
	}
}

main()
	.then(() => {
		console.log("\nagx ui e2e: all checks passed");
	})
	.catch((error) => {
		console.error(`\nFAILED: ${error instanceof E2eFailure ? error.message : error?.stack ?? error}`);
		process.exitCode = 1;
	})
	.finally(() => {
		for (const child of live) {
			child.kill("SIGKILL");
		}
		rmSync(home, { recursive: true, force: true });
	});
