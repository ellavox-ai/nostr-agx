import { describe, expect, it, vi } from "vitest";
import { buildCard, CARD_VERSION, TYPED_CARD_VERSION } from "./discovery";
import {
	AGENT_CARD_TYPED_METADATA_LIMITS as LIMITS,
	type AgentSkill,
	parseAgentCardMetadata,
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

function expectValid(metadata: unknown): void {
	const parsed = parseAgentCardMetadata(metadata);
	expect(parsed.warning).toBeUndefined();
}

function expectInvalid(metadata: unknown, code = "invalid_typed_metadata"): void {
	expect(parseAgentCardMetadata(metadata).warning?.code).toBe(code);
}

function schemaOfBytes(bytes: number): Record<string, unknown> {
	const schema: Record<string, unknown> = { const: "" };
	const overhead = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
	schema.const = "x".repeat(bytes - overhead);
	expect(new TextEncoder().encode(JSON.stringify(schema)).byteLength).toBe(bytes);
	return schema;
}

function metadataOfBytes(bytes: number): { skills: AgentSkill[] } {
	const skills: AgentSkill[] = [];
	for (let index = 0; ; index += 1) {
		const candidate = skill({
			id: `skill.${index}`,
			description: "x".repeat(LIMITS.descriptionChars),
			tags: undefined,
			inputModes: undefined,
			outputModes: undefined,
			inputSchema: undefined,
			outputSchema: undefined,
			features: undefined,
		});
		const size = new TextEncoder().encode(
			JSON.stringify({ skills: [...skills, candidate] }),
		).byteLength;
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
	const base = new TextEncoder().encode(
		JSON.stringify({ skills: [...skills, last] }),
	).byteLength;
	const padding = bytes - base;
	expect(padding).toBeGreaterThanOrEqual(0);
	expect(padding).toBeLessThanOrEqual(LIMITS.descriptionChars);
	last.description = "x".repeat(padding);
	return { skills: [...skills, last] };
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
		expect(parsed.warning).toBeUndefined();
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
		expect(parsed.warning).toBeUndefined();
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
		expect(parsed.warning?.code).toBe("unsupported_required_extension");
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
		expect(parsed.warning).toBeUndefined();
	});

	it("invalidates the whole typed unit for malformed entries", () => {
		expectInvalid({
			skills: [skill(), { id: 42, description: "bad" }],
			extensions: [{ uri: "agx.task-status.v1" }],
		});
	});

	it("rejects duplicate skill IDs and extension URIs", () => {
		expectInvalid({ skills: [skill(), skill()] });
		expectInvalid({
			extensions: [
				{ uri: "agx.task-status.v1" },
				{ uri: "agx.task-status.v1", required: true },
			],
		});
	});

	it("rejects wildcard typed skill IDs", () => {
		expectInvalid({ skills: [skill({ id: "*" })] });
		expectInvalid({ skills: [skill({ id: "invoice.*" })] });
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

	it.each(["$ref", "$schema", "$id", "pattern", "format", "patternProperties"])(
		"rejects unsupported schema keyword %s without fetching",
		(keyword) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			try {
				expectInvalid({
					skills: [skill({ inputSchema: { [keyword]: "https://example.com/schema" } })],
				});
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
	])("rejects invalid schema constraint %j", (schema) => {
		expectInvalid({ skills: [skill({ inputSchema: schema })] });
	});

	it("enforces schema depth, node, and property bounds", () => {
		expectValid({ skills: [skill({ inputSchema: schemaOfDepth(16) })] });
		expectInvalid({ skills: [skill({ inputSchema: schemaOfDepth(17) })] });
		expectValid({ skills: [skill({ inputSchema: schemaOfNodes(512) })] });
		expectInvalid({ skills: [skill({ inputSchema: schemaOfNodes(513) })] });
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
		expectInvalid({
			skills: [skill({ inputSchema: { properties: properties(257) } })],
		});
	});

	it("enforces inline schema and combined metadata UTF-8 byte bounds", () => {
		expectValid({
			skills: [skill({ inputSchema: schemaOfBytes(LIMITS.schemaBytes) })],
		});
		expectInvalid({
			skills: [skill({ inputSchema: schemaOfBytes(LIMITS.schemaBytes + 1) })],
		});
		const atLimit = metadataOfBytes(LIMITS.metadataBytes);
		expect(new TextEncoder().encode(JSON.stringify(atLimit)).byteLength).toBe(
			LIMITS.metadataBytes,
		);
		expectValid(atLimit);
		expectInvalid(metadataOfBytes(LIMITS.metadataBytes + 1));
	});

	const boundaries: [string, unknown, unknown][] = [
		[
			"skill count",
			{ skills: Array.from({ length: 64 }, (_, i) => skill({ id: `s${i}` })) },
			{ skills: Array.from({ length: 65 }, (_, i) => skill({ id: `s${i}` })) },
		],
		[
			"extension count",
			{ extensions: Array.from({ length: 32 }, (_, i) => ({ uri: `e${i}` })) },
			{ extensions: Array.from({ length: 33 }, (_, i) => ({ uri: `e${i}` })) },
		],
		[
			"skill ID",
			{ skills: [skill({ id: "x".repeat(200) })] },
			{ skills: [skill({ id: "x".repeat(201) })] },
		],
		[
			"description",
			{ skills: [skill({ description: "x".repeat(1000) })] },
			{ skills: [skill({ description: "x".repeat(1001) })] },
		],
		[
			"tag count",
			{ skills: [skill({ tags: Array.from({ length: 16 }, (_, i) => `t${i}`) })] },
			{ skills: [skill({ tags: Array.from({ length: 17 }, (_, i) => `t${i}`) })] },
		],
		[
			"tag length",
			{ skills: [skill({ tags: ["x".repeat(64)] })] },
			{ skills: [skill({ tags: ["x".repeat(65)] })] },
		],
		[
			"input mode count",
			{ skills: [skill({ inputModes: Array.from({ length: 8 }, (_, i) => `x${i}/y`) })] },
			{ skills: [skill({ inputModes: Array.from({ length: 9 }, (_, i) => `x${i}/y`) })] },
		],
		[
			"output mode count",
			{ skills: [skill({ outputModes: Array.from({ length: 8 }, (_, i) => `x${i}/y`) })] },
			{ skills: [skill({ outputModes: Array.from({ length: 9 }, (_, i) => `x${i}/y`) })] },
		],
		[
			"media type length",
			{ skills: [skill({ inputModes: [`a/${"x".repeat(126)}`] })] },
			{ skills: [skill({ inputModes: [`a/${"x".repeat(127)}`] })] },
		],
		[
			"feature count",
			{ skills: [skill({ features: Array.from({ length: 16 }, (_, i) => `f${i}`) })] },
			{ skills: [skill({ features: Array.from({ length: 17 }, (_, i) => `f${i}`) })] },
		],
		[
			"feature length",
			{ skills: [skill({ features: ["x".repeat(200)] })] },
			{ skills: [skill({ features: ["x".repeat(201)] })] },
		],
		[
			"extension URI length",
			{ extensions: [{ uri: "x".repeat(512) }] },
			{ extensions: [{ uri: "x".repeat(513) }] },
		],
	];

	it.each(boundaries)("accepts and rejects %s boundary", (_name, valid, invalid) => {
		expectValid(valid);
		expectInvalid(invalid);
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

	it("refuses to build invalid typed metadata", () => {
		expect(() => buildCard({ ...base, skills: [skill(), skill()] })).toThrow(
			/duplicate skill ID/,
		);
	});
});
