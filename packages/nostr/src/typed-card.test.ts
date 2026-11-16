import { agxEncodedJsonBytes } from "@nostr-agx/core";
import { describe, expect, it, vi } from "vitest";
import { buildCard, CARD_VERSION, TYPED_CARD_VERSION } from "./discovery";
import {
	AGENT_CARD_TYPED_METADATA_LIMITS as LIMITS,
	type AgentSkill,
	parseAgentCardMetadata,
	type TypedAgentCardMetadata,
} from "./typed-card";

const PUBKEY = "a".repeat(64);

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
	return {
		id: "invoice.review",
		description: "Review an invoice",
		tags: ["finance"],
		inputModes: ["application/json"],
		outputModes: ["application/json"],
		inputSchema: {
			type: "object",
			required: ["amount"],
			properties: { amount: { type: "number", minimum: 0 } },
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: { approved: { type: "boolean" } },
		},
		features: ["working"],
		...overrides,
	};
}

function codes(parsed: TypedAgentCardMetadata): string[] {
	return (parsed.warnings ?? []).map((warning) => warning.code);
}

function expectValid(metadata: unknown): void {
	const parsed = parseAgentCardMetadata(metadata);
	expect(parsed.warnings).toBeUndefined();
}

/** Exactly one warning of `code`, and no typed skills left. */
function expectRejected(metadata: unknown, code: string): void {
	const parsed = parseAgentCardMetadata(metadata);
	expect(codes(parsed)).toEqual([code]);
	expect(parsed.skills).toBeUndefined();
}

/** The whole typed unit is ignored. */
function expectInvalid(metadata: unknown): void {
	expectRejected(metadata, "invalid_typed_metadata");
	expect(parseAgentCardMetadata(metadata).extensions).toBeUndefined();
}

/** Only this skill is dropped; a valid skill beside it stays typed. */
function expectSkillDropped(bad: unknown): void {
	const parsed = parseAgentCardMetadata({
		skills: [skill({ id: "kept" }), bad],
	});
	expect(codes(parsed)).toEqual(["invalid_typed_skill"]);
	expect(parsed.skills?.map((kept) => kept.id)).toEqual(["kept"]);
}

/** UTF-8 bytes of `JSON.stringify`, encoded once (not as in the event). */
function singleEncodedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** `bytes` of padding as measured inside the event's escaped content. Quote
 * heavy, so the single and double encodings clearly differ: a `"` takes 4
 * bytes there, an `x` takes 1. */
function quotePadding(bytes: number): string {
	const quotes = Math.floor(bytes / 4);
	return '"'.repeat(quotes) + "x".repeat(bytes - quotes * 4);
}

function schemaOfBytes(bytes: number): Record<string, unknown> {
	const schema: Record<string, unknown> = { const: "" };
	const overhead = agxEncodedJsonBytes(schema) as number;
	schema.const = quotePadding(bytes - overhead);
	expect(agxEncodedJsonBytes(schema)).toBe(bytes);
	return schema;
}

function metadataOfBytes(bytes: number): { skills: AgentSkill[] } {
	const skills: AgentSkill[] = [];
	for (let index = 0; ; index += 1) {
		const candidate = skill({
			id: `skill.${index}`,
			description: '"'.repeat(LIMITS.descriptionChars),
			tags: undefined,
			inputModes: undefined,
			outputModes: undefined,
			inputSchema: undefined,
			outputSchema: undefined,
			features: undefined,
		});
		const size = agxEncodedJsonBytes({ skills: [...skills, candidate] }) as number;
		if (size > bytes) {
			break;
		}
		skills.push(candidate);
	}
	const last = skill({
		id: `skill.${skills.length}`,
		description: "",
		tags: undefined,
		inputModes: undefined,
		outputModes: undefined,
		inputSchema: undefined,
		outputSchema: undefined,
		features: undefined,
	});
	const base = agxEncodedJsonBytes({ skills: [...skills, last] }) as number;
	last.description = quotePadding(bytes - base);
	expect(last.description.length).toBeGreaterThan(0);
	expect(last.description.length).toBeLessThanOrEqual(LIMITS.descriptionChars);
	const metadata = { skills: [...skills, last] };
	expect(agxEncodedJsonBytes(metadata)).toBe(bytes);
	return metadata;
}

function schemaOfDepth(depth: number): Record<string, unknown> {
	let schema: Record<string, unknown> = { type: "string" };
	for (let current = 1; current < depth; current += 1) {
		schema = { type: "object", properties: { child: schema } };
	}
	return schema;
}

function schemaOfNodes(nodes: 512 | 513): Record<string, unknown> {
	const propertyCount = nodes === 512 ? 255 : 256;
	const properties = Object.fromEntries(
		Array.from({ length: propertyCount }, (_, index) => [
			`p${index}`,
			{ type: "array", items: { type: "string" } },
		]),
	);
	return {
		type: "object",
		properties,
		...(nodes === 512 ? { additionalProperties: { type: "string" } } : {}),
	};
}

describe("parseAgentCardMetadata", () => {
	it("keeps legacy-only cards unchanged", () => {
		expect(parseAgentCardMetadata({ capabilities: ["invoice.*"] })).toEqual({});
	});

	it("returns valid typed skills and optional extensions", () => {
		const parsed = parseAgentCardMetadata({
			skills: [skill()],
			extensions: [{ uri: "agx.task-status.v1", required: false }],
		});
		expect(parsed.warnings).toBeUndefined();
		expect(parsed.skills).toEqual([skill()]);
		expect(parsed.extensions).toEqual([
			{ uri: "agx.task-status.v1", required: false },
		]);
	});

	it("keeps optional extensions and skills", () => {
		const parsed = parseAgentCardMetadata({
			skills: [skill()],
			extensions: [{ uri: "https://example.com/extension", required: false }],
		});
		expect(parsed.skills).toHaveLength(1);
		expect(parsed.warnings).toBeUndefined();
	});

	it("falls back for an unknown required extension but retains its declaration", () => {
		const parsed = parseAgentCardMetadata({
			skills: [skill()],
			extensions: [{ uri: "agx.unknown.v1", required: true }],
		});
		expect(parsed.skills).toBeUndefined();
		expect(parsed.extensions).toEqual([
			{ uri: "agx.unknown.v1", required: true },
		]);
		expect(codes(parsed)).toEqual(["unsupported_required_extension"]);
	});

	it("an unknown required extension hides every typed skill even when they are all valid", () => {
		const parsed = parseAgentCardMetadata({
			skills: [skill(), skill({ id: "invoice.pay" })],
			extensions: [
				{ uri: "agx.task-status.v1", required: false },
				{ uri: "agx.unknown.v1", required: true },
			],
		});
		expect(parsed.skills).toBeUndefined();
		expect(parsed.extensions).toEqual([
			{ uri: "agx.task-status.v1", required: false },
			{ uri: "agx.unknown.v1", required: true },
		]);
		expect(codes(parsed)).toEqual(["unsupported_required_extension"]);
	});

	it("allows a required extension supported by the caller", () => {
		const parsed = parseAgentCardMetadata(
			{
				skills: [skill()],
				extensions: [{ uri: "agx.known.v1", required: true }],
			},
			new Set(["agx.known.v1"]),
		);
		expect(parsed.skills).toHaveLength(1);
		expect(parsed.warnings).toBeUndefined();
	});

	it("drops unknown fields on a skill and keeps it typed", () => {
		const parsed = parseAgentCardMetadata({
			skills: [{ ...skill(), futureField: { x: 1 } }],
		});
		expect(parsed.warnings).toBeUndefined();
		expect(parsed.skills).toEqual([skill()]);
		expect(parsed.skills?.[0]).not.toHaveProperty("futureField");
	});

	it("drops unknown fields on an extension", () => {
		const parsed = parseAgentCardMetadata({
			extensions: [{ uri: "agx.x.v1", required: false, since: "1.2.0" }],
		});
		expect(parsed.warnings).toBeUndefined();
		expect(parsed.extensions).toEqual([{ uri: "agx.x.v1", required: false }]);
		expect(parsed.extensions?.[0]).not.toHaveProperty("since");
	});

	it("drops only the invalid skill and keeps the others", () => {
		const parsed = parseAgentCardMetadata({
			skills: [
				skill({ id: "a" }),
				{ id: 42, description: "bad" },
				skill({ id: "b", inputSchema: { pattern: "x" } }),
				skill({ id: "c" }),
			],
			extensions: [{ uri: "agx.task-status.v1" }],
		});
		expect(parsed.skills?.map((kept) => kept.id)).toEqual(["a", "c"]);
		expect(codes(parsed)).toEqual(["invalid_typed_skill", "invalid_typed_skill"]);
		expect(parsed.warnings?.[0]?.message).toContain("skills.1");
		expect(parsed.warnings?.[1]?.message).toContain('"b"');
		expect(parsed.extensions).toEqual([{ uri: "agx.task-status.v1" }]);
	});

	it("drops every copy of a duplicated skill ID", () => {
		const parsed = parseAgentCardMetadata({
			skills: [skill(), skill(), skill({ id: "other" })],
		});
		expect(parsed.skills?.map((kept) => kept.id)).toEqual(["other"]);
		expect(codes(parsed)).toEqual(["invalid_typed_skill"]);
		expect(parsed.warnings?.[0]?.message).toContain("duplicate skill ID");
	});

	it("drops a valid copy of a skill ID when another copy is invalid", () => {
		const parsed = parseAgentCardMetadata({
			skills: [skill(), skill({ description: "" }), skill({ id: "other" })],
		});
		expect(parsed.skills?.map((kept) => kept.id)).toEqual(["other"]);
		expect(codes(parsed)).toEqual([
			"invalid_typed_skill",
			"invalid_typed_skill",
		]);
		expect(parsed.warnings?.[1]?.message).toContain("duplicate skill ID");
	});

	it("merges duplicate extension URIs, required if any copy is", () => {
		const metadata = {
			skills: [skill()],
			extensions: [
				{ uri: "agx.task-status.v1" },
				{ uri: "agx.task-status.v1", required: true },
			],
		};
		const supported = parseAgentCardMetadata(
			metadata,
			new Set(["agx.task-status.v1"]),
		);
		expect(supported.extensions).toEqual([
			{ uri: "agx.task-status.v1", required: true },
		]);
		expect(supported.skills).toHaveLength(1);
		expect(codes(supported)).toEqual(["invalid_typed_extension"]);

		const unsupported = parseAgentCardMetadata(metadata);
		expect(unsupported.skills).toBeUndefined();
		expect(codes(unsupported)).toEqual([
			"invalid_typed_extension",
			"unsupported_required_extension",
		]);
	});

	it("drops an invalid optional extension and keeps the skills", () => {
		const parsed = parseAgentCardMetadata({
			skills: [skill()],
			extensions: [{ uri: "" }, { uri: "agx.ok.v1" }],
		});
		expect(parsed.skills).toHaveLength(1);
		expect(parsed.extensions).toEqual([{ uri: "agx.ok.v1" }]);
		expect(codes(parsed)).toEqual(["invalid_typed_extension"]);
	});

	it("treats an invalid required extension as unsupported", () => {
		const parsed = parseAgentCardMetadata({
			skills: [skill()],
			extensions: [{ uri: 5, required: true }],
		});
		expect(parsed.skills).toBeUndefined();
		expect(codes(parsed)).toContain("unsupported_required_extension");
	});

	it("still rejects the whole unit for structural failures", () => {
		expectInvalid({ skills: {} });
		expectInvalid({ extensions: "agx.x.v1" });
		expectInvalid({
			skills: Array.from({ length: 65 }, (_, i) => skill({ id: `s${i}` })),
		});
		expectInvalid({
			skills: [skill()],
			extensions: Array.from({ length: 33 }, (_, i) => ({ uri: `e${i}` })),
		});
		expectInvalid(metadataOfBytes(LIMITS.metadataBytes + 1));
		expectInvalid("not an object");
	});

	it("drops wildcard typed skill IDs", () => {
		expectSkillDropped(skill({ id: "*" }));
		expectSkillDropped(skill({ id: "invoice.*" }));
	});

	it("supports the documented JSON Schema subset", () => {
		expectValid({
			skills: [
				skill({
					inputSchema: {
						type: ["object", "null"],
						properties: {
							name: { type: "string", minLength: 1, maxLength: 20 },
							ids: {
								type: "array",
								items: { type: "integer", minimum: 0, multipleOf: 1 },
								minItems: 0,
								maxItems: 5,
								uniqueItems: true,
							},
							kind: { enum: ["invoice", { nested: true }, null] },
							fixed: { const: { value: 1 } },
						},
						required: ["name"],
						additionalProperties: { type: "number", maximum: 10 },
						minProperties: 1,
						maxProperties: 5,
					},
				}),
			],
		});
	});

	it.each([
		["description", "an invoice"],
		["title", "Invoice"],
		["$schema", "https://json-schema.org/draft/2020-12/schema"],
		["default", { amount: 1 }],
		["examples", [{ amount: 2 }]],
	])("keeps a remote skill whose schema has %s", (keyword, value) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			const parsed = parseAgentCardMetadata({
				skills: [
					skill({
						inputSchema: {
							type: "object",
							[keyword]: value,
							properties: { amount: { type: "number", [keyword]: value } },
						},
					}),
				],
			});
			expect(parsed.warnings).toBeUndefined();
			expect(parsed.skills).toHaveLength(1);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps a skill but drops an annotation nested deeper than a payload may be", () => {
		let deep: unknown = 0;
		for (let level = 0; level < 4000; level++) deep = [deep];
		const parsed = parseAgentCardMetadata({
			skills: [
				skill({
					inputSchema: {
						type: "object",
						description: "An invoice",
						default: deep,
						properties: {
							amount: { type: "number", examples: deep, title: "Amount" },
						},
					},
				}),
			],
		});
		expect(parsed.warnings).toBeUndefined();
		// Compare key lists, not values: printing a 4,000-deep diff overflows.
		const schema = parsed.skills?.[0]?.inputSchema as {
			properties: { amount: Record<string, unknown> };
		};
		expect(Object.keys(schema).sort()).toEqual([
			"description",
			"properties",
			"type",
		]);
		expect(Object.keys(schema.properties.amount).sort()).toEqual([
			"title",
			"type",
		]);
	});

	it.each(["$ref", "$id", "pattern", "format", "patternProperties"])(
		"rejects unsupported schema keyword %s without fetching",
		(keyword) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			try {
				expectSkillDropped(
					skill({ inputSchema: { [keyword]: "https://example.com/schema" } }),
				);
				expect(fetchMock).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);

	it.each([
		{ type: [] },
		{ type: ["string", "string"] },
		{ minLength: -1 },
		{ maxItems: 1.5 },
		{ minimum: Number.POSITIVE_INFINITY },
		{ multipleOf: 0 },
		{ minLength: 5, maxLength: 2 },
		{ uniqueItems: "yes" },
		{ required: ["a", "a"] },
		{ enum: [] },
		{ enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] },
		{ const: Number.NaN },
		{ items: [] },
	])("drops a skill with invalid schema constraint %j", (schema) => {
		expectSkillDropped(skill({ inputSchema: schema }));
	});

	it.each([
		{ minimum: 5, maximum: 4 },
		{ exclusiveMinimum: 4, maximum: 4 },
		{ minimum: 4, exclusiveMaximum: 4 },
		{ exclusiveMinimum: 4, exclusiveMaximum: 4 },
	])("drops a skill whose schema has bounds that cannot both hold %j", (bounds) => {
		expectSkillDropped(skill({ inputSchema: bounds }));
		expectSkillDropped(skill({ outputSchema: { type: "array", items: bounds } }));
		expectValid({ skills: [skill({ inputSchema: { minimum: 4, maximum: 4 } })] });
	});

	it("enforces schema depth, node, and property bounds", () => {
		expectValid({ skills: [skill({ inputSchema: schemaOfDepth(16) })] });
		expectSkillDropped(skill({ inputSchema: schemaOfDepth(17) }));
		expectValid({ skills: [skill({ inputSchema: schemaOfNodes(512) })] });
		expectSkillDropped(skill({ inputSchema: schemaOfNodes(513) }));
		const properties = (count: number) =>
			Object.fromEntries(
				Array.from({ length: count }, (_, index) => [
					`p${index}`,
					{ type: "string" },
				]),
			);
		expectValid({
			skills: [skill({ inputSchema: { properties: properties(256) } })],
		});
		expectSkillDropped(skill({ inputSchema: { properties: properties(257) } }));
	});

	it("enforces the inline schema bound as encoded in the event", () => {
		expect(LIMITS.schemaBytes).toBe(16 * 1024);
		expectValid({
			skills: [skill({ inputSchema: schemaOfBytes(LIMITS.schemaBytes) })],
		});
		const over = schemaOfBytes(LIMITS.schemaBytes + 1);
		expect(singleEncodedBytes(over)).toBeLessThan(LIMITS.schemaBytes);
		expectSkillDropped(skill({ inputSchema: over }));
	});

	it("enforces the encoded typed metadata bound", () => {
		expect(LIMITS.metadataBytes).toBe(32_768);
		expectValid(metadataOfBytes(32_768));
		expectInvalid(metadataOfBytes(32_769));
		const overOnlyWhenEscaped = metadataOfBytes(32_769);
		expect(singleEncodedBytes(overOnlyWhenEscaped)).toBeLessThan(32_768);
		expectInvalid(overOnlyWhenEscaped);
	});

	const UNIT = "invalid_typed_metadata";
	const SKILL = "invalid_typed_skill";
	const EXTENSION = "invalid_typed_extension";
	const boundaries: [string, unknown, unknown, string][] = [
		[
			"skill count",
			{ skills: Array.from({ length: 64 }, (_, i) => skill({ id: `s${i}` })) },
			{ skills: Array.from({ length: 65 }, (_, i) => skill({ id: `s${i}` })) },
			UNIT,
		],
		[
			"extension count",
			{ extensions: Array.from({ length: 32 }, (_, i) => ({ uri: `e${i}` })) },
			{ extensions: Array.from({ length: 33 }, (_, i) => ({ uri: `e${i}` })) },
			UNIT,
		],
		[
			"skill ID",
			{ skills: [skill({ id: "x".repeat(200) })] },
			{ skills: [skill({ id: "x".repeat(201) })] },
			SKILL,
		],
		[
			"description",
			{ skills: [skill({ description: "x".repeat(1000) })] },
			{ skills: [skill({ description: "x".repeat(1001) })] },
			SKILL,
		],
		[
			"tag count",
			{ skills: [skill({ tags: Array.from({ length: 16 }, (_, i) => `t${i}`) })] },
			{ skills: [skill({ tags: Array.from({ length: 17 }, (_, i) => `t${i}`) })] },
			SKILL,
		],
		[
			"tag length",
			{ skills: [skill({ tags: ["x".repeat(64)] })] },
			{ skills: [skill({ tags: ["x".repeat(65)] })] },
			SKILL,
		],
		[
			"input mode count",
			{ skills: [skill({ inputModes: Array.from({ length: 8 }, (_, i) => `x${i}/y`) })] },
			{ skills: [skill({ inputModes: Array.from({ length: 9 }, (_, i) => `x${i}/y`) })] },
			SKILL,
		],
		[
			"output mode count",
			{ skills: [skill({ outputModes: Array.from({ length: 8 }, (_, i) => `x${i}/y`) })] },
			{ skills: [skill({ outputModes: Array.from({ length: 9 }, (_, i) => `x${i}/y`) })] },
			SKILL,
		],
		[
			"media type length",
			{ skills: [skill({ inputModes: [`a/${"x".repeat(126)}`] })] },
			{ skills: [skill({ inputModes: [`a/${"x".repeat(127)}`] })] },
			SKILL,
		],
		[
			"feature count",
			{ skills: [skill({ features: Array.from({ length: 16 }, (_, i) => `f${i}`) })] },
			{ skills: [skill({ features: Array.from({ length: 17 }, (_, i) => `f${i}`) })] },
			SKILL,
		],
		[
			"feature length",
			{ skills: [skill({ features: ["x".repeat(200)] })] },
			{ skills: [skill({ features: ["x".repeat(201)] })] },
			SKILL,
		],
		[
			"extension URI length",
			{ extensions: [{ uri: "x".repeat(512) }] },
			{ extensions: [{ uri: "x".repeat(513) }] },
			EXTENSION,
		],
	];

	it.each(boundaries)("accepts and rejects %s boundary", (_name, valid, invalid, code) => {
		expectValid(valid);
		expectRejected(invalid, code);
	});
});

describe("buildCard typed metadata", () => {
	const base = {
		org: "Acme",
		pubkey: PUBKEY,
		relays: ["wss://relay.example"],
		capabilities: ["invoice.review"],
		payloadTypes: ["application/json"],
	};

	it("keeps the legacy format version when typed fields are absent", () => {
		const card = buildCard(base);
		expect(card.version).toBe(CARD_VERSION);
		expect(card).not.toHaveProperty("skills");
		expect(card).not.toHaveProperty("extensions");
	});

	it("publishes validated typed fields with format version 1.1.0", () => {
		const card = buildCard({
			...base,
			skills: [skill()],
			extensions: [{ uri: "agx.task-status.v1", required: true }],
		});
		expect(card.version).toBe(TYPED_CARD_VERSION);
		expect(card.skills).toEqual([skill()]);
		expect(card.extensions).toEqual([
			{ uri: "agx.task-status.v1", required: true },
		]);
	});

	it("drops an invalid skill and builds the rest of the card", () => {
		const card = buildCard({
			...base,
			skills: [skill(), skill({ id: "x.*" })],
		});
		expect(card.skills).toEqual([skill()]);
		expect(card.capabilities).toEqual(["invoice.review"]);
		expect(card.version).toBe(TYPED_CARD_VERSION);
	});

	it("builds a legacy-only card when typed metadata is over the limit", () => {
		const card = buildCard({
			...base,
			...metadataOfBytes(LIMITS.metadataBytes + 1),
		});
		expect(card.version).toBe(CARD_VERSION);
		expect(card).not.toHaveProperty("skills");
		expect(card.capabilities).toEqual(["invoice.review"]);
		expect(card.org).toBe("Acme");
	});

	it("falls back to version 1.0.0 when every typed field is dropped", () => {
		const card = buildCard({
			...base,
			skills: [skill({ id: "x.*" }), skill({ description: "" })],
		});
		expect(card.version).toBe(CARD_VERSION);
		expect(card).not.toHaveProperty("skills");
		expect(card).not.toHaveProperty("extensions");
		expect(card.capabilities).toEqual(["invoice.review"]);
	});
});
