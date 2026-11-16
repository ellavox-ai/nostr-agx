import { describe, expect, it } from "vitest";
import { parseAgxAgentSkill } from "./agent-card";
import { validateAgxJsonPayload } from "./json-schema";

/** A skill as a peer's card delivers it: parsed from JSON text, where
 * `"__proto__"` is an own key. (An object literal would set the prototype.) */
function skillFromCard(schemaText: string, keyword = "inputSchema"): unknown {
	return JSON.parse(
		`{"id":"invoice.review","description":"Review an invoice","${keyword}":${schemaText}}`,
	);
}

describe("a __proto__ key in a skill schema", () => {
	it("is an own key once the card is parsed from text", () => {
		const skill = skillFromCard('{"__proto__":{"type":"string"},"type":"object"}') as {
			inputSchema: object;
		};
		expect(Object.hasOwn(skill.inputSchema, "__proto__")).toBe(true);
	});

	it.each(["inputSchema", "outputSchema"])(
		"makes the %s invalid at the top level instead of being dropped",
		(keyword) => {
			const parsed = parseAgxAgentSkill(
				skillFromCard('{"__proto__":{"type":"string"},"type":"object"}', keyword),
			);
			expect(parsed).toEqual({ problem: expect.stringMatching(/__proto__/) });
		},
	);

	it.each(['{"type":"string"}', "null", "1", '"x"', "[]", "{}"])(
		"is rejected whatever its value: %s",
		(value) => {
			expect(
				parseAgxAgentSkill(skillFromCard(`{"__proto__":${value}}`)),
			).toEqual({ problem: expect.stringMatching(/__proto__/) });
		},
	);

	it.each([
		["null", "null"],
		["an array", "[]"],
		["a string", '"x"'],
		["a number", "5"],
	])("leaves %s to the record check, not a thrown error", (_what, text) => {
		// `Object.hasOwn(null)` throws; the check must not turn that into the
		// generic "could not be parsed safely".
		expect(parseAgxAgentSkill(skillFromCard(text))).toEqual({
			problem: expect.stringMatching(/expected record/),
		});
	});

	it("leaves the same schema without the key valid", () => {
		const parsed = parseAgxAgentSkill(skillFromCard('{"type":"object"}'));
		expect(parsed).toEqual({
			skill: {
				id: "invoice.review",
				description: "Review an invoice",
				inputSchema: { type: "object" },
			},
		});
	});

	it("is kept and validated as a property name under properties", () => {
		const parsed = parseAgxAgentSkill(
			skillFromCard(
				'{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string"}}}',
			),
		);
		if (!("skill" in parsed)) {
			throw new Error(`expected a valid skill, got: ${parsed.problem}`);
		}
		const schema = parsed.skill.inputSchema as {
			properties: Record<string, unknown>;
		};
		expect(Object.hasOwn(schema.properties, "__proto__")).toBe(true);
		expect(validateAgxJsonPayload(schema, JSON.parse('{"__proto__":"x"}'))).toBeNull();
		expect(validateAgxJsonPayload(schema, JSON.parse('{"__proto__":5}'))).toMatch(
			/expected string/,
		);
		expect(validateAgxJsonPayload(schema, {})).toMatch(/missing required/);
	});

	it.each([
		["a property schema", '{"type":"object","properties":{"a":{"__proto__":{},"type":"number"}}}'],
		["items", '{"type":"array","items":{"__proto__":{},"type":"number"}}'],
		["additionalProperties", '{"type":"object","additionalProperties":{"__proto__":{}}}'],
	])("is still an unsupported keyword inside %s", (_where, schemaText) => {
		expect(parseAgxAgentSkill(skillFromCard(schemaText))).toEqual({
			problem: "invoice.review inputSchema: unsupported schema keyword: __proto__",
		});
	});
});
