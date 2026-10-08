import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	archiveDraft,
	isSafeDraftName,
	listDrafts,
	MAX_BODY_CHARS,
	parseDraft,
	readDraft,
} from "./drafts.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agx-drafts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NPUB = "npub1n0m8c4qn3434zy2q7nxj7v029pqyyfjfg0af98yfll6ksnvq3mps2ynyfz";

describe("parseDraft", () => {
	it("accepts the documented shape", () => {
		const draft = parseDraft(JSON.stringify({ to: NPUB, body: "hi", subject: "s", contextId: "abc" }));
		expect(draft).toMatchObject({ to: NPUB, body: "hi", subject: "s", contextId: "abc" });
	});

	it("rejects invalid JSON, missing fields and an empty body", () => {
		expect(() => parseDraft("{not json")).toThrow(/not valid JSON/);
		expect(() => parseDraft(JSON.stringify({ body: "x" }))).toThrow(/invalid/);
		expect(() => parseDraft(JSON.stringify({ to: NPUB, body: "" }))).toThrow(/invalid/);
	});

	it("caps the body at 8000 characters", () => {
		expect(() => parseDraft(JSON.stringify({ to: NPUB, body: "x".repeat(MAX_BODY_CHARS) }))).not.toThrow();
		expect(() => parseDraft(JSON.stringify({ to: NPUB, body: "x".repeat(MAX_BODY_CHARS + 1) }))).toThrow(/invalid/);
	});
});

describe("draft files", () => {
	it.each(["a.json", "2026-10-07T09.json", "reply_1.json"])("accepts the name %s", (name) => {
		expect(isSafeDraftName(name)).toBe(true);
	});
	it.each(["../x.json", "a/b.json", "a.txt", ".hidden.json", "", "a\\b.json", "a b.json"])("rejects the name %j", (name) => {
		expect(isSafeDraftName(name)).toBe(false);
	});

	it("lists drafts and reports the broken ones", () => {
		writeFileSync(join(dir, "ok.json"), JSON.stringify({ to: NPUB, body: "hi" }));
		writeFileSync(join(dir, "bad.json"), "nope");
		writeFileSync(join(dir, "notes.txt"), "ignored");
		const entries = listDrafts(dir);
		expect(entries.map((e) => e.name)).toEqual(["bad.json", "ok.json"]);
		expect(entries[0]?.error).toMatch(/not valid JSON/);
		expect(entries[1]?.draft?.body).toBe("hi");
	});

	it("returns nothing for a missing folder", () => {
		expect(listDrafts(join(dir, "nope"))).toEqual([]);
	});

	it("refuses to read outside the folder", () => {
		expect(() => readDraft(dir, "../etc.json")).toThrow(/Not a draft/);
	});

	it("moves a sent draft into sent/ so it cannot go twice", () => {
		writeFileSync(join(dir, "ok.json"), JSON.stringify({ to: NPUB, body: "hi" }));
		archiveDraft(dir, "ok.json");
		expect(existsSync(join(dir, "ok.json"))).toBe(false);
		expect(readdirSync(join(dir, "sent")).length).toBe(1);
		mkdirSync(join(dir, "again"));
	});
});
