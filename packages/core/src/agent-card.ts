import { z } from "zod";
import {
	AGX_JSON_SCHEMA_LIMITS,
	dropUnboundedAgxAnnotations,
	validateAgxJsonSchema,
} from "./json-schema";
import type { AgxAgentCardExtension, AgxAgentSkill } from "./transport";

/** Bounds on the typed skills and extensions an Agent Card carries. */
export const AGX_AGENT_CARD_LIMITS = {
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
	/** Each inline schema, measured the same way as `metadataBytes`. */
	schemaBytes: 16 * 1024,
	/** Typed metadata (`skills` + `extensions`), measured as UTF-8 inside the
	 * Agent Card event's escaped `content`; see {@link agxEncodedJsonBytes}. */
	metadataBytes: 32 * 1024,
	schemaDepth: AGX_JSON_SCHEMA_LIMITS.schemaDepth,
	schemaProperties: AGX_JSON_SCHEMA_LIMITS.schemaProperties,
	schemaNodes: AGX_JSON_SCHEMA_LIMITS.schemaNodes,
} as const;

const mediaTypePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const mediaTypeSchema = z
	.string()
	.min(1)
	.max(AGX_AGENT_CARD_LIMITS.mediaTypeChars)
	.regex(mediaTypePattern);
const schemaDocumentSchema = z.record(z.string(), z.unknown());

// Not strict: unknown fields are dropped, so a later card version stays
// readable as typed.
const skillSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.max(AGX_AGENT_CARD_LIMITS.skillIdChars)
			.refine((id) => id !== "*" && !id.endsWith(".*"), {
				message: "typed skill IDs must be concrete capability keys",
			}),
		description: z
			.string()
			.min(1)
			.max(AGX_AGENT_CARD_LIMITS.descriptionChars),
		tags: z
			.array(z.string().min(1).max(AGX_AGENT_CARD_LIMITS.tagChars))
			.max(AGX_AGENT_CARD_LIMITS.tags)
			.optional(),
		inputModes: z
			.array(mediaTypeSchema)
			.max(AGX_AGENT_CARD_LIMITS.modes)
			.optional(),
		outputModes: z
			.array(mediaTypeSchema)
			.max(AGX_AGENT_CARD_LIMITS.modes)
			.optional(),
		inputSchema: schemaDocumentSchema.optional(),
		outputSchema: schemaDocumentSchema.optional(),
		features: z
			.array(z.string().min(1).max(AGX_AGENT_CARD_LIMITS.featureChars))
			.max(AGX_AGENT_CARD_LIMITS.features)
			.optional(),
	});

const extensionSchema = z.object({
	uri: z.string().min(1).max(AGX_AGENT_CARD_LIMITS.extensionUriChars),
	required: z.boolean().optional(),
});

function issueProblem(error: z.ZodError): string {
	const issue = error.issues[0];
	const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
	return `${path}${issue?.message ?? "invalid value"}`;
}

/** The UTF-8 bytes `value` takes up inside a serialized Agent Card event:
 * encoded once as part of the card text, then escaped again as the event's
 * `content` string (without its two outer quotes). Null when `value` is not
 * JSON. */
export function agxEncodedJsonBytes(value: unknown): number | null {
	try {
		const text = JSON.stringify(value);
		return text === undefined
			? null
			: new TextEncoder().encode(JSON.stringify(text)).byteLength - 2;
	} catch {
		return null;
	}
}

/** Apply the Agent Card rules to one typed skill. On success returns a deep
 * copy, so later changes to `raw` cannot reach the parsed skill. */
export function parseAgxAgentSkill(
	raw: unknown,
): { skill: AgxAgentSkill } | { problem: string } {
	try {
		const parsed = skillSchema.safeParse(raw);
		if (!parsed.success) {
			return { problem: issueProblem(parsed.error) };
		}
		const skill = parsed.data;
		for (const keyword of ["inputSchema", "outputSchema"] as const) {
			const schema = skill[keyword];
			if (!schema) {
				continue;
			}
			const size = agxEncodedJsonBytes(schema);
			if (size === null || size > AGX_AGENT_CARD_LIMITS.schemaBytes) {
				return {
					problem: `${skill.id} ${keyword} exceeds ${AGX_AGENT_CARD_LIMITS.schemaBytes} bytes as encoded in the event`,
				};
			}
			const error = validateAgxJsonSchema(schema);
			if (error) {
				return { problem: `${skill.id} ${keyword}: ${error}` };
			}
		}
		const copy = JSON.parse(JSON.stringify(skill)) as AgxAgentSkill;
		dropUnboundedAgxAnnotations(copy.inputSchema);
		dropUnboundedAgxAnnotations(copy.outputSchema);
		return { skill: copy };
	} catch {
		return { problem: "skill could not be parsed safely" };
	}
}

/** Apply the Agent Card rules to one extension declaration. */
export function parseAgxAgentCardExtension(
	raw: unknown,
): { extension: AgxAgentCardExtension } | { problem: string } {
	try {
		const parsed = extensionSchema.safeParse(raw);
		if (!parsed.success) {
			return { problem: issueProblem(parsed.error) };
		}
		return {
			extension: JSON.parse(
				JSON.stringify(parsed.data),
			) as AgxAgentCardExtension,
		};
	} catch {
		return { problem: "extension could not be parsed safely" };
	}
}
