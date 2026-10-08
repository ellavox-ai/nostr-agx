import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { z } from "zod";

/**
 * Draft files: how an assistant hands a message to the user. The assistant
 * writes `{to, contextId?, subject?, body}` into a workspace folder; `agx ui`
 * lists it, and only a click in the browser sends it.
 */
export const MAX_BODY_CHARS = 8000;
export const DEFAULT_DRAFT_DIR = join(".elladex", "drafts");

export const draftSchema = z.object({
	to: z.string().min(1).max(200),
	contextId: z.string().max(200).nullish(),
	subject: z.string().max(500).nullish(),
	body: z.string().min(1).max(MAX_BODY_CHARS),
});

export type Draft = z.infer<typeof draftSchema>;

export interface DraftEntry {
	name: string;
	draft: Draft | null;
	error: string | null;
}

export function parseDraft(raw: string): Draft {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new Error("The draft is not valid JSON.");
	}
	const parsed = draftSchema.safeParse(json);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new Error(
			`The draft is invalid: ${issue?.path.join(".") || "root"} ${issue?.message ?? ""}`.trim(),
		);
	}
	return parsed.data;
}

/** A draft file name, never a path: no separators, `.json` only. */
export function isSafeDraftName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/.test(name);
}

export function loadDraftFile(path: string): Draft {
	const size = statSync(path).size;
	if (size > 64 * 1024) {
		throw new Error("The draft file is larger than 64 KiB.");
	}
	return parseDraft(readFileSync(path, "utf8"));
}

export function listDrafts(dir: string): DraftEntry[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir)
		.filter((name) => isSafeDraftName(name))
		.sort()
		.map((name) => {
			try {
				return { name, draft: loadDraftFile(join(dir, name)), error: null };
			} catch (error) {
				return {
					name,
					draft: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		});
}

export function readDraft(dir: string, name: string): Draft {
	if (!isSafeDraftName(name)) {
		throw new Error("Not a draft file name.");
	}
	const root = resolve(dir);
	const path = resolve(root, name);
	if (!path.startsWith(root + sep)) {
		throw new Error("Not a draft file name.");
	}
	return loadDraftFile(path);
}

/** Move a sent draft to `<dir>/sent/` so it cannot be sent twice. */
export function archiveDraft(dir: string, name: string): void {
	if (!isSafeDraftName(name)) {
		return;
	}
	const sentDir = join(dir, "sent");
	mkdirSync(sentDir, { recursive: true });
	renameSync(join(dir, name), join(sentDir, `${Date.now()}-${basename(name)}`));
}
