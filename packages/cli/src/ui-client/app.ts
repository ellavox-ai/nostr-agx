/**
 * The agx ui front end. Plain TypeScript, no framework, no network access
 * except this server's own `/api`.
 *
 * Safety rule for everything in this file: peer-controlled text only ever
 * reaches the page as a text node (`h()` and `textContent`). There is no
 * `innerHTML`, no markdown and no auto-linking, and `client-safety.test.ts`
 * fails the build if one of those appears.
 */

interface Message {
	id: string;
	direction: "in" | "out";
	peer: string;
	subject: string | null;
	contextId: string | null;
	contextIdWithheld: boolean;
	text: string;
	at: string;
	deliveryStatus: string | null;
	readAt: string | null;
	peerStatus: string | null;
	peerLabel: string | null;
	peerVerified: boolean;
}

interface Held {
	npub: string;
	nip05: string | null;
	nip05Check: { status: string; detail: string | null };
	firstSeenAt: string;
	count: number;
	messages: { at: string; text: string; subject: string | null }[];
}

interface Peer {
	npub: string;
	status: "allowed" | "ignored" | "blocked";
	label: string | null;
	handle: string | null;
	verified: boolean;
}

interface Thread {
	contextId: string | null;
	contextIdWithheld: boolean;
	peer: string;
	subject: string | null;
	messages: number;
	unread: number;
	lastMessageAt: string;
}

interface Identity {
	profile: string;
	npub: string;
	relays: string[];
	doctor: { status: string; detail: string | null };
}

interface DraftEntry {
	name: string;
	draft: { to: string; contextId?: string | null; subject?: string | null; body: string } | null;
	error: string | null;
}

interface ComposeState {
	to: string;
	subject: string;
	body: string;
	contextId: string | null;
	draftName: string | null;
}

interface ApiError {
	error: { code: string; message: string; findings?: { kind: string; line: number }[] };
}

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | number | ((event: Event) => void) | undefined>;

const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf"]')?.content ?? "";
const root = document.getElementById("app") as HTMLElement;
const compose: ComposeState = { to: "", subject: "", body: "", contextId: null, draftName: null };
let heldCount = 0;

/** Build an element. Strings become text nodes; attributes are set, never parsed as HTML. */
function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === false) {
			continue;
		}
		if (typeof value === "function") {
			el.addEventListener(key.replace(/^on/, ""), value);
		} else if (key === "class") {
			el.className = String(value);
		} else if (key === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
			el.value = String(value);
		} else if (/^(id|type|role|for|placeholder|disabled|rows|maxlength|tabindex|autocomplete|aria-[a-z-]+|data-[a-z-]+|name|spellcheck)$/.test(key)) {
			el.setAttribute(key, value === true ? "" : String(value));
		}
	}
	for (const child of children) {
		if (child === null || child === undefined || child === false) {
			continue;
		}
		el.append(typeof child === "string" ? document.createTextNode(child) : child);
	}
	return el;
}

/** Append children, skipping the empty ones. */
function put(parent: Element, ...children: Child[]): void {
	for (const child of children) {
		if (child !== null && child !== undefined && child !== false) {
			parent.append(typeof child === "string" ? document.createTextNode(child) : child);
		}
	}
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & Partial<ApiError> }> {
	const response = await fetch(path, {
		method,
		headers: { "x-agx-csrf": csrf, ...(body === undefined ? {} : { "content-type": "application/json" }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let data: unknown = {};
	try {
		data = await response.json();
	} catch {
		// A non-JSON error body is shown by status alone.
	}
	return { ok: response.ok, status: response.status, data: data as T & Partial<ApiError> };
}

function toast(message: string, isError = false): void {
	const box = document.getElementById("toast");
	if (!box) {
		return;
	}
	const item = h("div", { class: isError ? "t error" : "t" }, message);
	box.append(item);
	setTimeout(() => item.remove(), 6000);
}

/** Show the number of held senders on the Held tab, or hide it at zero. */
function setHeldBadge(count: number): void {
	heldCount = count;
	const button = document.querySelectorAll("nav button")[3];
	if (!button) {
		return;
	}
	button.querySelector(".badge")?.remove();
	if (count > 0) {
		button.append(h("span", { class: "badge", "aria-label": `${count} held` }, String(count)));
	}
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** In-app replacement for window.confirm; resolves false on Cancel or Esc. */
function askConfirm(title: string, message: string, confirmLabel: string): Promise<boolean> {
	return new Promise((resolve) => {
		const dialog = h("dialog", { "aria-labelledby": "ask-title" }) as HTMLDialogElement;
		let answer = false;
		const finish = (value: boolean): void => {
			answer = value;
			dialog.close();
		};
		dialog.addEventListener("close", () => {
			dialog.remove();
			resolve(answer);
		});
		put(
			dialog,
			h("h2", { id: "ask-title" }, title),
			h("p", { class: "ask-message" }, message),
			h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onclick: () => finish(true) }, confirmLabel), h("button", { class: "btn", type: "button", onclick: () => finish(false) }, "Cancel")),
		);
		document.body.append(dialog);
		dialog.showModal();
	});
}

function shortNpub(npub: string): string {
	return npub.length > 20 ? `${npub.slice(0, 10)}…${npub.slice(-6)}` : npub;
}

function npubView(npub: string): HTMLElement {
	return h(
		"span",
		{},
		h("code", { class: "npub", "aria-label": "address" }, shortNpub(npub)),
		" ",
		h(
			"button",
			{
				class: "btn",
				type: "button",
				"aria-label": "Copy full address",
				onclick: () => {
					void navigator.clipboard.writeText(npub).then(
						() => toast("Address copied."),
						() => toast("Could not copy.", true),
					);
				},
			},
			"Copy",
		),
	);
}

function when(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function snippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

function peerLabel(message: Message): HTMLElement {
	return h(
		"span",
		{},
		message.peerLabel ?? (message.peerStatus === "allowed" ? "Allowed sender" : "Unknown agent"),
		" ",
		message.peerVerified ? h("span", { class: "chip ok" }, "verified") : h("span", { class: "chip" }, "unverified"),
	);
}

function empty(text: string): HTMLElement {
	return h("p", { class: "empty" }, text);
}

// ----------------------------------------------------------------- views

async function viewMessages(direction: "inbox" | "sent", main: HTMLElement): Promise<void> {
	let query = "";
	let unread = false;
	const list = h("ul", { class: "list" });
	const load = async (): Promise<void> => {
		const params = new URLSearchParams();
		if (query) {
			params.set("q", query);
		}
		if (unread) {
			params.set("unread", "1");
		}
		const result = await api<{ messages: Message[] }>("GET", `/api/${direction}?${params}`);
		list.replaceChildren();
		const rows = result.data.messages ?? [];
		if (rows.length === 0) {
			list.append(h("li", {}, empty(direction === "inbox" ? "No messages yet." : "Nothing sent yet.")));
			return;
		}
		for (const message of rows) {
			const open = (): void => {
				location.hash = message.contextId ? `#/thread/${encodeURIComponent(message.contextId)}` : "#/threads";
			};
			list.append(
				h(
					"li",
					{ class: message.direction === "in" && !message.readAt ? "row unread" : "row" },
					h(
						"div",
						{ class: "meta" },
						peerLabel(message),
						npubView(message.peer),
						h("span", {}, when(message.at)),
						message.direction === "out" && message.deliveryStatus ? h("span", { class: "chip" }, message.deliveryStatus) : null,
						message.direction === "in" && !message.readAt ? h("span", { class: "chip ok" }, "unread") : null,
					),
					h("div", {}, h("strong", {}, message.subject ?? "(no subject)")),
					h("div", { class: "snippet" }, snippet(message.text)),
					h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: open }, "Open thread")),
				),
			);
		}
	};
	put(main, 
		h("h2", {}, direction === "inbox" ? "Inbox" : "Sent"),
		h("p", { class: "snippet" }, direction === "inbox" ? "Messages from senders you have allowed." : "Messages you sent from this machine."),
		h(
			"div",
			{ class: "toolbar" },
			h("label", { for: "q", class: "sr" }, "Search"),
			h("input", {
				id: "q",
				type: "search",
				placeholder: "Search subject, text or address",
				maxlength: 200,
				oninput: (event) => {
					query = (event.target as HTMLInputElement).value;
					void load();
				},
			}),
			direction === "inbox"
				? h(
						"label",
						{},
						h("input", {
							type: "checkbox",
							onchange: (event) => {
								unread = (event.target as HTMLInputElement).checked;
								void load();
							},
						}),
						" Unread only",
					)
				: null,
		),
		list,
	);
	await load();
}

async function viewThreads(main: HTMLElement): Promise<void> {
	const result = await api<{ threads: Thread[] }>("GET", "/api/threads");
	const list = h("ul", { class: "list" });
	const threads = result.data.threads ?? [];
	if (threads.length === 0) {
		list.append(h("li", {}, empty("No conversations yet.")));
	}
	for (const thread of threads) {
		list.append(
			h(
				"li",
				{ class: thread.unread > 0 ? "row unread" : "row" },
				h("div", { class: "meta" }, npubView(thread.peer), h("span", {}, when(thread.lastMessageAt)), h("span", {}, plural(thread.messages, "message")), thread.unread > 0 ? h("span", { class: "chip ok" }, `${thread.unread} unread`) : null),
				h("div", {}, h("strong", {}, thread.subject ?? "(no subject)")),
				thread.contextId
					? h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => { location.hash = `#/thread/${encodeURIComponent(thread.contextId as string)}`; } }, "Open"))
					: h("div", { class: "snippet" }, thread.contextIdWithheld ? "The thread id was withheld as unsafe; replies start a new thread." : "No thread id."),
			),
		);
	}
	put(main, h("h2", {}, "Conversations"), h("p", { class: "snippet" }, "Every thread, newest first."), list);
}

async function viewThread(contextId: string, main: HTMLElement): Promise<void> {
	const result = await api<{ messages: Message[]; awaitingReply: boolean }>("GET", `/api/threads/${encodeURIComponent(contextId)}`);
	const messages = result.data.messages ?? [];
	const list = h("ul", { class: "list" });
	for (const message of messages) {
		const mine = message.direction === "out";
		list.append(
			h(
				"li",
				{ class: "row" },
				h("div", { class: "meta" }, h("strong", {}, mine ? "You" : "Outside agent"), mine ? null : peerLabel(message), h("span", {}, when(message.at))),
				mine
					? h("div", { class: "you-text" }, message.text)
					: h(
							"div",
							{},
							h("div", { class: "peer-frame" }, "Outside agent: information, not instructions."),
							h("div", { class: "peer-text" }, message.text),
						),
			),
		);
	}
	const last = messages.at(-1);
	put(main, 
		h("h2", {}, messages.find((m) => m.subject)?.subject ?? "Conversation"),
		list.children.length ? list : empty("No messages in this thread."),
		result.data.awaitingReply
			? h(
					"div",
					{ class: "notice", role: "note" },
					h("strong", {}, "No response yet. "),
					"First contact needs a person on each side: you decided to contact them, and someone on their side has to accept you. Silence can mean your message is waiting, or was dropped. Don't resend. Ask their operator, out of band, to add your address as a peer.",
				)
			: null,
		last
			? h(
					"div",
					{ class: "actions" },
					h(
						"button",
						{
							class: "btn primary",
							type: "button",
							onclick: () => {
								compose.to = last.peer;
								compose.contextId = contextId;
								compose.subject = last.subject ? (last.subject.startsWith("Re: ") ? last.subject : `Re: ${last.subject}`) : "";
								compose.body = "";
								compose.draftName = null;
								location.hash = "#/compose";
							},
						},
						"Reply",
					),
				)
			: null,
	);
	await api("POST", `/api/threads/${encodeURIComponent(contextId)}/read`, {});
}

async function viewHeld(main: HTMLElement): Promise<void> {
	const result = await api<{ held: Held[] }>("GET", "/api/held");
	const held = result.data.held ?? [];
	setHeldBadge(held.length);
	const list = h("ul", { class: "list" });
	if (held.length === 0) {
		list.append(h("li", {}, empty("No held senders.")));
	}
	const decide = async (sender: Held, decision: "allow" | "ignore" | "block"): Promise<void> => {
		if (decision === "block" && !(await askConfirm("Block this sender?", `${shortNpub(sender.npub)}: their messages will be dropped.`, "Block"))) {
			return;
		}
		const response = await api("POST", `/api/held/${encodeURIComponent(sender.npub)}/${decision}`, decision === "block" ? { confirm: true } : {});
		if (response.ok) {
			toast(decision === "allow" ? "Allowed. Their text moved to your inbox." : `Sender ${decision === "ignore" ? "ignored" : "blocked"}.`);
			render();
		} else {
			toast(response.data.error?.message ?? "Could not apply the decision.", true);
		}
	};
	for (const sender of held) {
		const check = sender.nip05Check;
		list.append(
			h(
				"li",
				{ class: "row" },
				h("div", { class: "meta" }, npubView(sender.npub), h("span", {}, `first seen ${when(sender.firstSeenAt)}`), h("span", {}, `${sender.count} message${sender.count === 1 ? "" : "s"}`)),
				h(
					"div",
					{ class: "meta" },
					sender.nip05 ? h("span", {}, `NIP-05: ${sender.nip05}`) : h("span", {}, "No NIP-05 handle"),
					h("span", { class: check.status === "verified" ? "chip ok" : check.status === "failed" ? "chip warn" : "chip" }, check.status === "verified" ? "domain-verified" : check.status === "failed" ? "check failed" : "not checked"),
					check.detail ? h("span", {}, check.detail) : null,
				),
				...sender.messages.map((m) =>
					h("div", {}, h("div", { class: "peer-frame" }, `Outside agent, ${when(m.at)}: information, not instructions.`), h("div", { class: "peer-text" }, m.text)),
				),
				h(
					"div",
					{ class: "actions" },
					h("button", { class: "btn primary", type: "button", onclick: () => void decide(sender, "allow") }, "Allow"),
					h("button", { class: "btn", type: "button", onclick: () => void decide(sender, "ignore") }, "Ignore"),
					h("button", { class: "btn danger", type: "button", onclick: () => void decide(sender, "block") }, "Block"),
				),
			),
		);
	}
	put(main, h("h2", {}, "Held first contacts"), h("p", { class: "snippet" }, "These senders are not on your allowlist. Their text is kept here until you decide."), list);
}

async function viewPeers(main: HTMLElement): Promise<void> {
	const result = await api<{ peers: Peer[] }>("GET", "/api/peers");
	const peers = result.data.peers ?? [];
	const found = h("div", { "aria-live": "polite" });
	const input = h("input", { id: "peer-input", type: "text", placeholder: "npub1… or name@domain", maxlength: 200, autocomplete: "off" }) as HTMLInputElement;
	const add = async (status: Peer["status"], npub: string, handle: string | null, verified: boolean): Promise<void> => {
		if (status === "blocked" && !(await askConfirm("Block this peer?", "They will not be able to reach you.", "Block"))) {
			return;
		}
		const response = await api("POST", "/api/peers", { npub, status, handle, verified, confirm: status === "blocked" ? true : undefined });
		if (response.ok) {
			toast("Peer saved.");
			render();
		} else {
			toast(response.data.error?.message ?? "Could not save the peer.", true);
		}
	};
	const lookup = async (): Promise<void> => {
		const value = input.value.trim();
		found.replaceChildren();
		if (!value) {
			return;
		}
		if (value.includes("@") || value.length === 64) {
			const response = await api<{ agent: { address: string; handle: string | null; verified: boolean; displayName: string | null } }>("GET", `/api/lookup?q=${encodeURIComponent(value)}`);
			if (!response.ok) {
				found.append(h("p", { class: "snippet" }, response.data.error?.message ?? "Not found."));
				return;
			}
			const agent = response.data.agent;
			found.append(
				h(
					"div",
					{ class: "row" },
					h("div", { class: "meta" }, h("strong", {}, agent.displayName ?? agent.handle ?? "Agent"), agent.verified ? h("span", { class: "chip ok" }, "domain-verified") : h("span", { class: "chip" }, "unverified"), npubView(agent.address)),
					h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onclick: () => void add("allowed", agent.address, agent.handle, agent.verified) }, "Allow this peer")),
				),
			);
		} else {
			found.append(h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onclick: () => void add("allowed", value, null, false) }, "Allow this address")));
		}
	};
	const list = h("ul", { class: "list" });
	if (peers.length === 0) {
		list.append(h("li", {}, empty("No peers yet.")));
	}
	for (const peer of peers) {
		list.append(
			h(
				"li",
				{ class: "row" },
				h("div", { class: "meta" }, h("strong", {}, peer.label ?? peer.handle ?? "Peer"), h("span", { class: peer.status === "allowed" ? "chip ok" : peer.status === "blocked" ? "chip warn" : "chip" }, peer.status), peer.verified ? h("span", { class: "chip ok" }, "domain-verified") : null, npubView(peer.npub)),
				h(
					"div",
					{ class: "actions" },
					...(["allowed", "ignored", "blocked"] as const).filter((s) => s !== peer.status).map((s) => h("button", { class: s === "blocked" ? "btn danger" : "btn", type: "button", onclick: () => void add(s, peer.npub, peer.handle, peer.verified) }, `Mark ${s}`)),
					h("button", { class: "btn", type: "button", onclick: () => { void api("DELETE", `/api/peers/${encodeURIComponent(peer.npub)}`).then(() => render()); } }, "Remove"),
				),
			),
		);
	}
	put(main, 
		h("h2", {}, "Peers"),
		h("label", { for: "peer-input" }, "Add a peer by address or Elladex handle"),
		h("div", { class: "toolbar" }, input, h("button", { class: "btn", type: "button", onclick: () => void lookup() }, "Look up")),
		found,
		list,
	);
}

async function viewCompose(main: HTMLElement): Promise<void> {
	const [drafts, preset] = await Promise.all([
		api<{ enabled: boolean; drafts: DraftEntry[] }>("GET", "/api/drafts"),
		api<{ draft: { to: string; contextId?: string | null; subject?: string | null; body: string } | null }>("GET", "/api/compose"),
	]);
	if (preset.data.draft && !compose.body && !compose.to) {
		const d = preset.data.draft;
		Object.assign(compose, { to: d.to, subject: d.subject ?? "", body: d.body, contextId: d.contextId ?? null, draftName: null });
	}
	const warning = h("div", { "aria-live": "polite" });
	const status = h("div", { class: "snippet", "aria-live": "polite" });
	const toInput = h("input", { id: "to", type: "text", value: compose.to, placeholder: "npub1… or 64-character hex key", maxlength: 200, autocomplete: "off", oninput: (e) => { compose.to = (e.target as HTMLInputElement).value; } }) as HTMLInputElement;
	const subjectInput = h("input", { id: "subject", type: "text", value: compose.subject, maxlength: 500, oninput: (e) => { compose.subject = (e.target as HTMLInputElement).value; } }) as HTMLInputElement;
	const bodyInput = h("textarea", { id: "body", value: compose.body, maxlength: 8000, rows: 10, oninput: (e) => { compose.body = (e.target as HTMLTextAreaElement).value; void scan(); } }) as HTMLTextAreaElement;
	let scanTimer: number | undefined;
	async function scan(): Promise<void> {
		window.clearTimeout(scanTimer);
		scanTimer = window.setTimeout(async () => {
			const response = await api<{ findings: { kind: string; line: number }[] }>("POST", "/api/scan", { text: `${compose.subject}\n${compose.body}` });
			warning.replaceChildren();
			const findings = response.data.findings ?? [];
			if (findings.length > 0) {
				warning.append(h("div", { class: "notice", role: "alert" }, h("strong", {}, "This looks like it contains a credential: "), findings.map((f) => `${f.kind} (line ${f.line})`).join(", "), ". Remove it unless you chose to share it with this peer."));
			}
		}, 250);
	}
	const confirmDialog = h("dialog", { "aria-labelledby": "confirm-title" }) as HTMLDialogElement;
	const send = async (extra: Record<string, boolean> = {}): Promise<void> => {
		const payload = { to: compose.to.trim(), subject: compose.subject || null, contextId: compose.contextId, body: compose.body, confirmedText: compose.body, confirmedTo: compose.to.trim(), draft: compose.draftName, ...extra };
		// The server wants the recipient as an npub; show what it resolved to.
		const response = await api<{ ok: boolean }>("POST", "/api/send", payload);
		if (response.ok) {
			toast("Sent.");
			Object.assign(compose, { to: "", subject: "", body: "", contextId: null, draftName: null });
			location.hash = "#/sent";
			return;
		}
		const error = response.data.error;
		if (error?.code === "follow_up_guard" && (await askConfirm("Send another follow-up?", error.message, "Send anyway"))) {
			return send({ ...extra, allowFollowUp: true });
		}
		if (error?.code === "secrets_found" && (await askConfirm("Possible credential in this message", error.message, "Send anyway"))) {
			return send({ ...extra, acknowledgeSecrets: true });
		}
		toast(error?.message ?? "Could not send.", true);
	};
	const review = (): void => {
		if (!compose.to.trim() || !compose.body.trim()) {
			toast("Give a recipient and a message.", true);
			return;
		}
		confirmDialog.replaceChildren();
		put(confirmDialog, 
			h("h2", { id: "confirm-title" }, "Send this exact message?"),
			h("p", {}, "To: ", h("code", { class: "npub" }, compose.to.trim())),
			compose.subject ? h("p", {}, "Subject: ", compose.subject) : null,
			h("div", { class: "you-text" }, compose.body),
			h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onclick: () => { confirmDialog.close(); void send(); } }, "Send"), h("button", { class: "btn", type: "button", onclick: () => confirmDialog.close() }, "Cancel")),
		);
		confirmDialog.showModal();
	};
	const draftList = h("ul", { class: "list" });
	for (const entry of drafts.data.drafts ?? []) {
		draftList.append(
			h(
				"li",
				{ class: "row" },
				h("div", { class: "meta" }, h("strong", {}, entry.name), entry.error ? h("span", { class: "chip warn" }, entry.error) : null),
				entry.draft ? h("div", { class: "snippet" }, snippet(entry.draft.body)) : null,
				entry.draft
					? h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => { const d = entry.draft as NonNullable<DraftEntry["draft"]>; Object.assign(compose, { to: d.to, subject: d.subject ?? "", body: d.body, contextId: d.contextId ?? null, draftName: entry.name }); render(); } }, "Load into Compose"))
					: null,
			),
		);
	}
	status.textContent = compose.contextId ? "Replying in an existing thread." : "This starts a new thread. First contact: they must accept you before they see it.";
	put(main, 
		h("h2", {}, "Compose"),
		h("p", { class: "snippet" }, "Nothing is sent until you press Send and confirm."),
		h(
			"section",
			{ class: "card" },
			h("label", { for: "to" }, "Recipient"),
			toInput,
			h("label", { for: "subject" }, "Subject (optional)"),
			subjectInput,
			h("label", { for: "body" }, "Message (up to 8000 characters)"),
			bodyInput,
			status,
			warning,
			h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onclick: review }, "Review and send")),
		),
		confirmDialog,
		h("h2", { class: "section" }, "Drafts"),
		drafts.data.enabled ? (draftList.children.length ? draftList : empty("No draft files.")) : empty("No drafts folder. Start agx ui with --drafts <dir>, or create ./.elladex/drafts."),
	);
	void scan();
}

async function viewIdentity(main: HTMLElement): Promise<void> {
	const result = await api<Identity>("GET", "/api/identity");
	const identity = result.data;
	put(main, 
		h("h2", {}, "Identity"),
		h("section", { class: "card" },
		h("p", {}, "Profile: ", h("strong", {}, identity.profile)),
		h("p", {}, "Your address: ", npubView(identity.npub)),
		h("p", {}, "Relays:"),
		h("ul", {}, ...identity.relays.map((relay) => h("li", {}, relay))),
		h("p", {}, "Status: ", h("span", { class: identity.doctor.status === "ok" ? "chip ok" : identity.doctor.status === "unknown" ? "chip" : "chip warn" }, identity.doctor.status), identity.doctor.detail ? ` ${identity.doctor.detail}` : null),
		h("p", { class: "snippet" }, "Your key never leaves this machine and is never shown here."),
		),
	);
}

// ----------------------------------------------------------------- shell

const ROUTES: [string, string][] = [
	["inbox", "Inbox"],
	["sent", "Sent"],
	["threads", "Threads"],
	["held", "Held"],
	["peers", "Peers"],
	["compose", "Compose"],
	["identity", "Identity"],
];

function render(): void {
	const hash = location.hash.replace(/^#\//, "") || "inbox";
	const [name, arg] = hash.split("/");
	const main = h("main", { id: "main", tabindex: -1 });
	const nav = h(
		"nav",
		{ "aria-label": "Sections" },
		...ROUTES.map(([key, label]) =>
			h("button", { type: "button", "aria-current": key === name || (name === "thread" && key === "threads") ? "page" : undefined, onclick: () => { location.hash = `#/${key}`; } }, label, key === "held" && heldCount > 0 ? h("span", { class: "badge", "aria-label": `${heldCount} held` }, String(heldCount)) : null),
		),
	);
	root.replaceChildren(h("header", { class: "top" }, h("h1", {}, "agx ui"), nav), main, h("div", { id: "toast", role: "status", "aria-live": "polite" }));
	const views: Record<string, () => Promise<void>> = {
		inbox: () => viewMessages("inbox", main),
		sent: () => viewMessages("sent", main),
		threads: () => viewThreads(main),
		thread: () => viewThread(decodeURIComponent(arg ?? ""), main),
		held: () => viewHeld(main),
		peers: () => viewPeers(main),
		compose: () => viewCompose(main),
		identity: () => viewIdentity(main),
	};
	const view = views[name ?? "inbox"] ?? views.inbox;
	void (view as () => Promise<void>)().then(() => main.focus({ preventScroll: true }));
	void api<{ held: Held[] }>("GET", "/api/held").then((r) => setHeldBadge(r.data.held?.length ?? 0));
}

window.addEventListener("hashchange", render);
render();
