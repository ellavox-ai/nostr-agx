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

	it("fails multipleOf when the quotient overflows instead of passing", () => {
		expectInvalid({ type: "number", multipleOf: 1e-300 }, 1e300, /multipleOf/);
	});

	describe("multipleOf for whole numbers", () => {
		const multipleOf = (step: number) => ({ type: "number", multipleOf: step });

		it("still fails closed when the quotient of a fractional value overflows", () => {
			// A whole value is decided exactly; a fractional one reaches the rounding test.
			expect(1.5 / 1e-320).toBe(Number.POSITIVE_INFINITY);
			expectInvalid(multipleOf(1e-320), 1.5, /multipleOf/);
		});

		/** The exact answer, from integer arithmetic. */
		const isMultiple = (value: number, step: number) =>
			BigInt(value) % BigInt(step) === 0n;

		it("rejects a huge whole number that is not a multiple", () => {
			// Past 2^53 every double is whole, so a rounding test passes anything.
			expect(1e20 % 3).not.toBe(0);
			expectInvalid(multipleOf(3), 1e20, /multipleOf/);
			expectInvalid(multipleOf(3), -1e20, /multipleOf/);
			expectInvalid(multipleOf(3), 2 ** 53 + 2, /multipleOf/);
			expectInvalid(multipleOf(7), 1e300, /multipleOf/);
		});

		it("accepts a huge whole number that is a multiple", () => {
			expectValid(multipleOf(3), 3 * 2 ** 60);
			expectValid(multipleOf(4), 2 ** 60);
			expectValid(multipleOf(4), -(2 ** 60));
			expectValid(multipleOf(5), 1e20);
			expectValid(multipleOf(1e10), 1e20);
			expectValid(multipleOf(2 ** 60), 2 ** 61);
			expectValid(multipleOf(3), 0);
			expectValid(multipleOf(3), -0);
		});

		it("is exact at and around Number.MAX_SAFE_INTEGER", () => {
			const safe = Number.MAX_SAFE_INTEGER; // 2^53 - 1 = 6361 * 69431 * 20394401
			expect(isMultiple(safe, 6361)).toBe(true);
			expectValid(multipleOf(6361), safe);
			expectValid(multipleOf(6361), -safe);
			expectInvalid(multipleOf(3), safe, /multipleOf/);
			expectInvalid(multipleOf(3), -safe, /multipleOf/);
			// 2^53 is the first value that is no longer a safe integer.
			expectValid(multipleOf(2), safe + 1);
			expectInvalid(multipleOf(3), safe + 1, /multipleOf/);
			expectValid(multipleOf(2 ** 52), safe + 1);
		});

		it("is exact below 2^53 too, where the rounding test already passed everything", () => {
			// 2e15 / 3 is about 6.7e14: past 2^49 the rounding test cannot reject.
			expect(2e15 % 3).not.toBe(0);
			expectInvalid(multipleOf(3), 2e15, /multipleOf/);
			expectInvalid(multipleOf(3), -2e15, /multipleOf/);
			expectValid(multipleOf(5), 2e15);
			// A tiny quotient also hid a value that is not a multiple.
			expectInvalid(multipleOf(1e16), 3, /multipleOf/);
			expectValid(multipleOf(1e16), 0);
			expectValid(multipleOf(1e16), 1e16);
		});

		it("agrees with integer arithmetic for whole numbers of every size", () => {
			const values = [
				1, 6, 7, 1e15, 2e15, 4e15, Number.MAX_SAFE_INTEGER, 2 ** 53,
				2 ** 53 + 2, 3 * 2 ** 60, 2 ** 60, 1e20, 1e21, 1e300,
			].flatMap((value) => [value, -value]);
			const steps = [1, 2, 3, 4, 5, 7, 1e10, 3e16, 2 ** 60];
			for (const value of values) {
				for (const step of steps) {
					const problem = validateAgxJsonPayload(multipleOf(step), value);
					expect(
						problem === null,
						`${value} multipleOf ${step}`,
					).toBe(isMultiple(value, step));
				}
			}
		});

		it("still accepts a huge whole number against a decimal step", () => {
			// Every whole number is a multiple of 0.1, 0.01 or 0.2, so a peer that
			// sends one must not be rejected. Only a whole step is decided exactly.
			expectValid(multipleOf(0.1), 1e20);
			expectValid(multipleOf(0.1), -1e20);
			expectValid(multipleOf(0.01), 1e16);
			expectValid(multipleOf(0.01), 2 ** 53);
			expectValid(multipleOf(0.2), 1e20);
			expectValid(multipleOf(0.5), 1e20);
			expectValid(multipleOf(0.25), -1e20);
			expectValid(multipleOf(0.1), Number.MAX_SAFE_INTEGER);
			// Not pinned either way: a huge value against a step such as 0.3 or 1.5.
			// The rounding test accepts it; only an exact decimal check could decide it.
		});

		it("keeps the rounding test for fractions and small numbers", () => {
			expectValid(multipleOf(0.1), 0.1 + 0.2);
			expectValid(multipleOf(0.1), 3);
			expectValid(multipleOf(0.01), 1e13);
			expectValid(multipleOf(0.5), 2.5);
			expectInvalid(multipleOf(0.5), 2.6, /multipleOf/);
			expectValid(multipleOf(3), 6);
			expectValid(multipleOf(3), -6);
			expectInvalid(multipleOf(3), 7, /multipleOf/);
			expectInvalid(multipleOf(3), 1e15, /multipleOf/);
			expectInvalid(multipleOf(3), 4.5, /multipleOf/);
			// Pins the base behaviour for a value that is not whole (float noise is
			// forgiven by the rounding test), not a claim that it is right: a whole
			// step has only whole multiples.
			expectValid(multipleOf(3), 6.000000000000001);
		});
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

	it("accepts and ignores annotation keywords", () => {
		const annotations = {
			description: "an invoice",
			title: 42,
			$schema: "https://json-schema.org/draft/2020-12/schema",
			default: { amount: 1 },
			examples: [{ amount: 2 }],
		};
		expect(
			validateAgxJsonSchema({
				...annotations,
				type: "object",
				properties: { a: { ...annotations, type: "number" } },
			}),
		).toBeNull();
		expectInvalid(
			{ required: ["a"], properties: { a: { type: "number", default: 5 } } },
			{},
			/missing required/,
		);
	});

	it("validates values as their JSON encoding", () => {
		expectValid(
			{
				type: "object",
				properties: { a: { type: "number" } },
				additionalProperties: false,
			},
			{ a: 1, b: undefined },
		);
		expectValid({ type: "string" }, new Date(0));
		expectInvalid({ type: "object" }, new Date(0), /expected object/);
		expectValid(
			{ type: "object", required: ["id"] },
			new (class Row {
				id = 1;
			})(),
		);
		expectValid({}, undefined);
		expectValid({ type: "null" }, undefined);
		expectInvalid({ type: "object" }, undefined, /expected object/);
		expectInvalid({ type: "number" }, Number.POSITIVE_INFINITY, /expected number/);
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expectInvalid({}, cyclic, /cannot be encoded as JSON/);
		expectInvalid({}, { n: BigInt(1) }, /cannot be encoded as JSON/);
	});

	it("rejects unencodable, over-deep, and oversized payloads without throwing", () => {
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expectInvalid({}, cyclic, /cannot be encoded as JSON/);
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
