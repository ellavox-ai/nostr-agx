import {
	AGX_JSON_SCHEMA_LIMITS,
	validateAgxJsonSchema,
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

export const AGENT_CARD_TYPED_METADATA_LIMITS = {
	skills: 64,
	extensions: 32,
	skillIdChars: 200,
	descriptionChars: 1_000,
	tags: 16,
	tagChars: 64,
	modes: 8,
	mediaTypeChars: 128,
	features: 16,
	featureChars: 200,
	extensionUriChars: 512,
	schemaBytes: 16 * 1024,
	metadataBytes: 64 * 1024,
	schemaDepth: AGX_JSON_SCHEMA_LIMITS.schemaDepth,
	schemaProperties: AGX_JSON_SCHEMA_LIMITS.schemaProperties,
	schemaNodes: AGX_JSON_SCHEMA_LIMITS.schemaNodes,
} as const;

export const SUPPORTED_AGENT_CARD_EXTENSIONS: ReadonlySet<string> = new Set();

const mediaTypePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const mediaTypeSchema = z
	.string()
	.min(1)
	.max(AGENT_CARD_TYPED_METADATA_LIMITS.mediaTypeChars)
	.regex(mediaTypePattern);
const schemaDocumentSchema = z.record(z.string(), z.unknown());

const skillSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.max(AGENT_CARD_TYPED_METADATA_LIMITS.skillIdChars)
			.refine((id) => id !== "*" && !id.endsWith(".*"), {
				message: "typed skill IDs must be concrete capability keys",
			}),
		description: z
			.string()
			.min(1)
			.max(AGENT_CARD_TYPED_METADATA_LIMITS.descriptionChars),
		tags: z
			.array(
				z
					.string()
					.min(1)
					.max(AGENT_CARD_TYPED_METADATA_LIMITS.tagChars),
			)
			.max(AGENT_CARD_TYPED_METADATA_LIMITS.tags)
			.optional(),
		inputModes: z
			.array(mediaTypeSchema)
			.max(AGENT_CARD_TYPED_METADATA_LIMITS.modes)
			.optional(),
		outputModes: z
			.array(mediaTypeSchema)
			.max(AGENT_CARD_TYPED_METADATA_LIMITS.modes)
			.optional(),
		inputSchema: schemaDocumentSchema.optional(),
		outputSchema: schemaDocumentSchema.optional(),
		features: z
			.array(
				z
					.string()
					.min(1)
					.max(AGENT_CARD_TYPED_METADATA_LIMITS.featureChars),
			)
			.max(AGENT_CARD_TYPED_METADATA_LIMITS.features)
			.optional(),
	})
	.strict();

const extensionSchema = z
	.object({
		uri: z
			.string()
			.min(1)
			.max(AGENT_CARD_TYPED_METADATA_LIMITS.extensionUriChars),
		required: z.boolean().optional(),
	})
	.strict();

const typedMetadataSchema = z.object({
	skills: z
		.array(skillSchema)
		.max(AGENT_CARD_TYPED_METADATA_LIMITS.skills)
		.optional(),
	extensions: z
		.array(extensionSchema)
		.max(AGENT_CARD_TYPED_METADATA_LIMITS.extensions)
		.optional(),
});

export interface TypedAgentCardMetadata {
	skills?: AgentSkill[];
	extensions?: AgentCardExtension[];
	warning?: AgentCardMetadataWarning;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Size(value: unknown): number | null {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined
			? null
			: new TextEncoder().encode(serialized).byteLength;
	} catch {
		return null;
	}
}

function invalid(detail: string): TypedAgentCardMetadata {
	return {
		warning: {
			code: "invalid_typed_metadata",
			message: `Typed Agent Card metadata ignored: ${detail}`,
		},
	};
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
	const serializedSize = utf8Size({
		...(raw.skills === undefined ? {} : { skills: raw.skills }),
		...(raw.extensions === undefined ? {} : { extensions: raw.extensions }),
	});
	if (
		serializedSize === null ||
		serializedSize > AGENT_CARD_TYPED_METADATA_LIMITS.metadataBytes
	) {
		return invalid(
			`serialized metadata exceeds ${AGENT_CARD_TYPED_METADATA_LIMITS.metadataBytes} UTF-8 bytes or is not JSON`,
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

	const skillIds = new Set<string>();
	for (const skill of parsed.data.skills ?? []) {
		if (skillIds.has(skill.id)) {
			return invalid(`duplicate skill ID: ${skill.id}`);
		}
		skillIds.add(skill.id);
		for (const keyword of ["inputSchema", "outputSchema"] as const) {
			const schema = skill[keyword];
			if (!schema) {
				continue;
			}
			const size = utf8Size(schema);
			if (
				size === null ||
				size > AGENT_CARD_TYPED_METADATA_LIMITS.schemaBytes
			) {
				return invalid(
					`${skill.id} ${keyword} exceeds ${AGENT_CARD_TYPED_METADATA_LIMITS.schemaBytes} UTF-8 bytes`,
				);
			}
			const error = validateAgxJsonSchema(schema);
			if (error) {
				return invalid(`${skill.id} ${keyword}: ${error}`);
			}
		}
	}

	const extensionUris = new Set<string>();
	for (const extension of parsed.data.extensions ?? []) {
		if (extensionUris.has(extension.uri)) {
			return invalid(`duplicate extension URI: ${extension.uri}`);
		}
		extensionUris.add(extension.uri);
	}
	const unsupportedRequired = (parsed.data.extensions ?? []).filter(
		(extension) =>
			extension.required === true && !supportedExtensions.has(extension.uri),
	);
	const result: TypedAgentCardMetadata = {};
	if (parsed.data.extensions !== undefined) {
		result.extensions = parsed.data.extensions;
	}
	if (unsupportedRequired.length > 0) {
		result.warning = {
			code: "unsupported_required_extension",
			message: `Typed skills ignored because required extensions are unsupported: ${unsupportedRequired.map((extension) => extension.uri).join(", ")}`,
		};
		return result;
	}
	if (parsed.data.skills !== undefined) {
		result.skills = parsed.data.skills;
	}
	return result;
}
