import { describe, expect, it } from "vitest";
import {
	AGX_JSON_SCHEMA_LIMITS,
	validateAgxJsonPayload,
	validateAgxJsonSchema,
} from "./json-schema";

function expectValid(schema: Record<string, unknown>, value: unknown): void {
	expect(validateAgxJsonPayload(schema, value)).toBeNull();
}

function expectInvalid(
	schema: Record<string, unknown>,
	value: unknown,
	message?: string | RegExp,
): void {
	const problem = validateAgxJsonPayload(schema, value);
	expect(problem).not.toBeNull();
	if (message) {
		expect(problem).toMatch(message);
	}
}

describe("AGX JSON Schema validation", () => {
	it("accepts every supported primitive and a type union", () => {
		expectValid({ type: "null" }, null);
		expectValid({ type: "boolean" }, true);
		expectValid({ type: "string" }, "agx");
		expectValid({ type: "number" }, 1.5);
		expectValid({ type: "integer" }, 2);
		expectValid({ type: "array" }, []);
		expectValid({ type: "object" }, {});
		expectValid({ type: ["string", "null"] }, null);
		expectInvalid({ type: "integer" }, 1.5, /expected integer/);
		expectInvalid({ type: ["string", "null"] }, false, /expected string or null/);
	});

	it("checks required, nested, and additional object properties", () => {
		const schema = {
			type: "object",
			required: ["amount"],
			properties: {
				amount: { type: "number", minimum: 0 },
				note: { type: "string" },
			},
			additionalProperties: false,
		};
		expectValid(schema, { amount: 2, note: "ok" });
		expectInvalid(schema, {}, /missing required property/);
		expectInvalid(schema, { amount: -1 }, /below minimum/);
		expectInvalid(schema, { amount: 2, extra: true }, /additional property/);
		expectInvalid(schema, { amount: "2" }, /expected number/);
	});

	it("supports schemas for additional properties", () => {
		const schema = {
			type: "object",
			properties: { known: { type: "string" } },
			additionalProperties: { type: "integer" },
		};
		expectValid(schema, { known: "yes", count: 2 });
		expectInvalid(schema, { count: 2.5 }, /expected integer/);
	});

	it("checks array items, lengths, uniqueness, and object property counts", () => {
		const schema = {
			type: "array",
			items: { type: "object", maxProperties: 1 },
			minItems: 1,
			maxItems: 3,
			uniqueItems: true,
		};
		expectValid(schema, [{ id: 1 }, { id: 2 }]);
		expectInvalid(schema, [], /fewer than minItems/);
		expectInvalid(schema, [{ id: 1 }, { id: 1 }], /not unique/);
		expectInvalid(schema, [{ a: 1, b: 2 }], /more than maxProperties/);
		expectInvalid(schema, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], /more than maxItems/);
	});

	it("checks string lengths by Unicode code point", () => {
		expectValid({ type: "string", minLength: 1, maxLength: 1 }, "😀");
		expectInvalid({ type: "string", minLength: 2 }, "a", /shorter/);
		expectInvalid({ type: "string", maxLength: 1 }, "ab", /longer/);
	});

	it("checks numeric bounds and multipleOf without floating-point false positives", () => {
		expectValid({ type: "number", multipleOf: 0.1 }, 0.3);
		expectInvalid({ type: "number", multipleOf: 0.1 }, 0.35, /multipleOf/);
		expectValid({ type: "number", exclusiveMinimum: 0, exclusiveMaximum: 2 }, 1);
		expectInvalid({ type: "number", exclusiveMinimum: 0 }, 0, /exclusiveMinimum/);
		expectInvalid({ type: "number", exclusiveMaximum: 2 }, 2, /exclusiveMaximum/);
	});

	it("compares const and enum values as JSON, independent of object key order", () => {
		expectValid({ const: { a: 1, b: [true] } }, { b: [true], a: 1 });
		expectValid({ enum: ["new", { a: 1 }] }, { a: 1 });
		expectInvalid({ enum: ["new", "done"] }, "other", /enum/);
	});

	it("rejects unsupported or malformed schemas", () => {
		expect(validateAgxJsonSchema({ $ref: "https://example.com/schema" })).toMatch(
			/unsupported schema keyword/,
		);
		expect(validateAgxJsonSchema({ type: "wat" })).toMatch(/type is invalid/);
		expect(validateAgxJsonSchema({ minItems: -1 })).toMatch(/non-negative/);
		expect(validateAgxJsonSchema({ properties: { a: true } })).toMatch(
			/property schemas must be objects/,
		);
		expectInvalid({ pattern: ".*" }, "anything", /invalid schema/);
	});

	it("rejects non-JSON, cyclic, over-deep, and oversized payloads without throwing", () => {
		expectInvalid({}, undefined, /not JSON/);
		expectInvalid({}, Number.POSITIVE_INFINITY, /finite/);
		expectInvalid({ type: "object" }, new Date(), /not JSON/);
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expectInvalid({}, cyclic, /cycle/);
		let deep: unknown = null;
		for (let index = 0; index <= AGX_JSON_SCHEMA_LIMITS.payloadDepth; index += 1) {
			deep = [deep];
		}
		expectInvalid({}, deep, /nesting exceeds/);
		expectInvalid(
			{ type: "array", items: { type: "integer" } },
			Array.from({ length: AGX_JSON_SCHEMA_LIMITS.payloadNodes }, () => 0),
			/more than .* nodes/,
		);
	});
});
