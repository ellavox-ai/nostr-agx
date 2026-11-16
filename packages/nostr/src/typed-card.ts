import {
	AGX_AGENT_CARD_LIMITS,
	agxEncodedJsonBytes,
	parseAgxAgentCardExtension,
	parseAgxAgentSkill,
} from "@nostr-agx/core";
import type {
	AgxAgentCardExtension,
	AgxAgentCardMetadataWarning,
	AgxAgentSkill,
	AgxJsonSchema,
} from "@nostr-agx/core";
import { z } from "zod";

export type AgentSkill = AgxAgentSkill;
export type AgentCardExtension = AgxAgentCardExtension;
export type AgentCardMetadataWarning = AgxAgentCardMetadataWarning;
export type AgentCardJsonSchema = AgxJsonSchema;

export const AGENT_CARD_TYPED_METADATA_LIMITS = AGX_AGENT_CARD_LIMITS;

export const SUPPORTED_AGENT_CARD_EXTENSIONS: ReadonlySet<string> = new Set();

const typedMetadataSchema = z.object({
	skills: z
		.array(z.unknown())
		.max(AGENT_CARD_TYPED_METADATA_LIMITS.skills)
		.optional(),
	extensions: z
		.array(z.unknown())
		.max(AGENT_CARD_TYPED_METADATA_LIMITS.extensions)
		.optional(),
});

export interface TypedAgentCardMetadata {
	skills?: AgentSkill[];
	extensions?: AgentCardExtension[];
	/** Why typed metadata, or part of it, was left out. Absent when none was. */
	warnings?: AgentCardMetadataWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string): TypedAgentCardMetadata {
	return {
		warnings: [
			{
				code: "invalid_typed_metadata",
				message: `Typed Agent Card metadata ignored: ${detail}`,
			},
		],
	};
}

/** `skills.3 ("invoice.review")`: where an entry sat, and its name if it has one. */
function entryLabel(
	list: "skills" | "extensions",
	index: number,
	entry: unknown,
): string {
	const name = isRecord(entry) ? entry[list === "skills" ? "id" : "uri"] : undefined;
	return typeof name === "string"
		? `${list}.${index} (${JSON.stringify(name.slice(0, 120))})`
		: `${list}.${index}`;
}

export function parseAgentCardMetadata(
	raw: unknown,
	supportedExtensions: ReadonlySet<string> = SUPPORTED_AGENT_CARD_EXTENSIONS,
): TypedAgentCardMetadata {
	try {
		return parseAgentCardMetadataUnsafe(raw, supportedExtensions);
	} catch {
		return invalid("metadata could not be parsed safely");
	}
}

function parseAgentCardMetadataUnsafe(
	raw: unknown,
	supportedExtensions: ReadonlySet<string>,
): TypedAgentCardMetadata {
	if (!isRecord(raw)) {
		return invalid("card content is not an object");
	}
	if (raw.skills === undefined && raw.extensions === undefined) {
		return {};
	}
	const encodedSize = agxEncodedJsonBytes({
		...(raw.skills === undefined ? {} : { skills: raw.skills }),
		...(raw.extensions === undefined ? {} : { extensions: raw.extensions }),
	});
	if (
		encodedSize === null ||
		encodedSize > AGENT_CARD_TYPED_METADATA_LIMITS.metadataBytes
	) {
		return invalid(
			`metadata exceeds ${AGENT_CARD_TYPED_METADATA_LIMITS.metadataBytes} bytes as encoded in the event, or is not JSON`,
		);
	}
	const parsed = typedMetadataSchema.safeParse({
		skills: raw.skills,
		extensions: raw.extensions,
	});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		return invalid(`${path}${issue?.message ?? "invalid metadata"}`);
	}

	const warnings: AgentCardMetadataWarning[] = [];

	// Extensions: an invalid entry hides only itself, unless it says
	// `required: true`; then it counts as an unsupported required extension.
	const extensionsByUri = new Map<string, AgentCardExtension>();
	const invalidRequired: string[] = [];
	for (const [index, entry] of (parsed.data.extensions ?? []).entries()) {
		const label = entryLabel("extensions", index, entry);
		const parsedExtension = parseAgxAgentCardExtension(entry);
		if ("problem" in parsedExtension) {
			warnings.push({
				code: "invalid_typed_extension",
				message: `Typed extension ignored: ${label}: ${parsedExtension.problem}`,
			});
			if (isRecord(entry) && entry.required === true) {
				invalidRequired.push(label);
			}
			continue;
		}
		const extension = parsedExtension.extension;
		const declared = extensionsByUri.get(extension.uri);
		if (!declared) {
			extensionsByUri.set(extension.uri, extension);
			continue;
		}
		warnings.push({
			code: "invalid_typed_extension",
			message: `Typed extension declared more than once, merged: ${label}`,
		});
		if (extension.required === true) {
			declared.required = true;
		}
	}
	const extensions = [...extensionsByUri.values()];
	const unsupportedRequired = [
		...extensions
			.filter(
				(extension) =>
					extension.required === true &&
					!supportedExtensions.has(extension.uri),
			)
			.map((extension) => extension.uri),
		...invalidRequired,
	];
	const result: TypedAgentCardMetadata = {};
	if (extensions.length > 0) {
		result.extensions = extensions;
	}
	if (unsupportedRequired.length > 0) {
		warnings.push({
			code: "unsupported_required_extension",
			message: `Typed skills ignored because required extensions are unsupported: ${unsupportedRequired.join(", ")}`,
		});
		result.warnings = warnings;
		return result;
	}

	// Skills: an invalid entry hides only itself. A duplicated ID drops every
	// copy, since there is no telling which one the publisher meant.
	// Count IDs over every entry, valid or not, so an invalid copy still
	// makes the ID ambiguous.
	const idCounts = new Map<string, number>();
	for (const entry of parsed.data.skills ?? []) {
		const id = isRecord(entry) ? entry.id : undefined;
		if (typeof id === "string") {
			idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
		}
	}
	const parsedSkills: AgentSkill[] = [];
	for (const [index, entry] of (parsed.data.skills ?? []).entries()) {
		const parsedSkill = parseAgxAgentSkill(entry);
		if ("problem" in parsedSkill) {
			warnings.push({
				code: "invalid_typed_skill",
				message: `Typed skill ignored: ${entryLabel("skills", index, entry)}: ${parsedSkill.problem}`,
			});
			continue;
		}
		parsedSkills.push(parsedSkill.skill);
	}
	for (const [id, count] of idCounts) {
		if (count > 1) {
			warnings.push({
				code: "invalid_typed_skill",
				message: `Typed skills ignored: duplicate skill ID: ${id.slice(0, 120)}`,
			});
		}
	}
	const skills = parsedSkills.filter((skill) => idCounts.get(skill.id) === 1);
	if (skills.length > 0) {
		result.skills = skills;
	}
	if (warnings.length > 0) {
		result.warnings = warnings;
	}
	return result;
}
