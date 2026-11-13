export type AgxJsonSchema = Record<string, unknown>;

export const AGX_JSON_SCHEMA_LIMITS = {
	schemaDepth: 16,
	schemaProperties: 256,
	schemaNodes: 512,
	payloadDepth: 64,
	payloadNodes: 16_384,
} as const;

const schemaTypes = new Set([
	"null",
	"boolean",
	"object",
	"array",
	"number",
	"string",
	"integer",
]);
const schemaKeywords = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
]);
/** Accepted whatever their value and otherwise ignored: never checked, never
 * walked, never fetched (`$schema`), and `default` is never applied. */
const annotationKeywords = new Set([
	"description",
	"title",
	"$schema",
	"default",
	"examples",
]);
const nonNegativeIntegerKeywords = new Set([
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"minProperties",
	"maxProperties",
]);
const numberKeywords = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
]);

interface Budget {
	nodes: number;
	properties: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalJson(value[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function jsonValueProblem(
	value: unknown,
	budget: Budget,
	depth: number,
	stack: WeakSet<object>,
): string | null {
	if (depth > AGX_JSON_SCHEMA_LIMITS.payloadDepth) {
		return `JSON nesting exceeds ${AGX_JSON_SCHEMA_LIMITS.payloadDepth}`;
	}
	budget.nodes += 1;
	if (budget.nodes > AGX_JSON_SCHEMA_LIMITS.payloadNodes) {
		return `JSON has more than ${AGX_JSON_SCHEMA_LIMITS.payloadNodes} nodes`;
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return null;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? null : "JSON numbers must be finite";
	}
	if (!Array.isArray(value) && !isRecord(value)) {
		return "value is not JSON";
	}
	if (stack.has(value)) {
		return "JSON value contains a cycle";
	}
	stack.add(value);
	for (const child of Array.isArray(value)
		? value
		: Object.values(value)) {
		const problem = jsonValueProblem(child, budget, depth + 1, stack);
		if (problem) {
			stack.delete(value);
			return problem;
		}
	}
	stack.delete(value);
	return null;
}

function boundedJsonValueProblem(value: unknown): string | null {
	return jsonValueProblem(
		value,
		{ nodes: 0, properties: 0 },
		1,
		new WeakSet(),
	);
}

function validateSchemaNode(
	schema: Record<string, unknown>,
	depth: number,
	budget: Budget,
): string | null {
	if (depth > AGX_JSON_SCHEMA_LIMITS.schemaDepth) {
		return `schema nesting exceeds ${AGX_JSON_SCHEMA_LIMITS.schemaDepth}`;
	}
	budget.nodes += 1;
	if (budget.nodes > AGX_JSON_SCHEMA_LIMITS.schemaNodes) {
		return `schema has more than ${AGX_JSON_SCHEMA_LIMITS.schemaNodes} nodes`;
	}
	for (const keyword of Object.keys(schema)) {
		if (!schemaKeywords.has(keyword) && !annotationKeywords.has(keyword)) {
			return `unsupported schema keyword: ${keyword.slice(0, 120)}`;
		}
	}

	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type)
			? schema.type
			: [schema.type];
		if (
			types.length === 0 ||
			types.some(
				(type) => typeof type !== "string" || !schemaTypes.has(type),
			) ||
			new Set(types).size !== types.length
		) {
			return "schema type is invalid";
		}
	}

	for (const keyword of nonNegativeIntegerKeywords) {
		const value = schema[keyword];
		if (
			value !== undefined &&
			(!Number.isInteger(value) || (value as number) < 0)
		) {
			return `${keyword} must be a non-negative integer`;
		}
	}
	for (const keyword of numberKeywords) {
		const value = schema[keyword];
		if (
			value !== undefined &&
			(typeof value !== "number" || !Number.isFinite(value))
		) {
			return `${keyword} must be a finite number`;
		}
	}
	if (
		schema.multipleOf !== undefined &&
		(schema.multipleOf as number) <= 0
	) {
		return "multipleOf must be greater than zero";
	}
	if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
		return "uniqueItems must be boolean";
	}
	for (const [minimum, maximum] of [
		["minLength", "maxLength"],
		["minimum", "maximum"],
		["minItems", "maxItems"],
		["minProperties", "maxProperties"],
	] as const) {
		if (
			schema[minimum] !== undefined &&
			schema[maximum] !== undefined &&
			(schema[minimum] as number) > (schema[maximum] as number)
		) {
			return `${minimum} exceeds ${maximum}`;
		}
	}

	if (schema.const !== undefined) {
		const problem = boundedJsonValueProblem(schema.const);
		if (problem) {
			return `const must be a bounded JSON value: ${problem}`;
		}
	}
	if (schema.enum !== undefined) {
		if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
			return "enum must be a non-empty array";
		}
		for (const value of schema.enum) {
			const problem = boundedJsonValueProblem(value);
			if (problem) {
				return `enum entries must be bounded JSON values: ${problem}`;
			}
		}
		const values = new Set(schema.enum.map(canonicalJson));
		if (values.size !== schema.enum.length) {
			return "enum entries must be unique";
		}
	}

	if (schema.required !== undefined) {
		if (
			!Array.isArray(schema.required) ||
			schema.required.some((name) => typeof name !== "string") ||
			new Set(schema.required).size !== schema.required.length
		) {
			return "required must contain unique property names";
		}
	}

	if (schema.properties !== undefined) {
		if (!isRecord(schema.properties)) {
			return "properties must be an object";
		}
		const entries = Object.entries(schema.properties);
		budget.properties += entries.length;
		if (
			budget.properties >
			AGX_JSON_SCHEMA_LIMITS.schemaProperties
		) {
			return `schema has more than ${AGX_JSON_SCHEMA_LIMITS.schemaProperties} properties`;
		}
		for (const child of Object.values(schema.properties)) {
			if (!isRecord(child)) {
				return "property schemas must be objects";
			}
			const error = validateSchemaNode(child, depth + 1, budget);
			if (error) {
				return error;
			}
		}
	}

	for (const keyword of ["items", "additionalProperties"] as const) {
		const child = schema[keyword];
		if (child === undefined || (keyword === "additionalProperties" && typeof child === "boolean")) {
			continue;
		}
		if (!isRecord(child)) {
			return `${keyword} must be a schema object${keyword === "additionalProperties" ? " or boolean" : ""}`;
		}
		const error = validateSchemaNode(child, depth + 1, budget);
		if (error) {
			return error;
		}
	}
	return null;
}

/** Remove, in place, every annotation whose value is larger or deeper than a
 * task payload may be. Annotations never make a schema invalid, but one of
 * any depth would make printing the schema blow up. Call it on a copy. */
export function dropUnboundedAgxAnnotations(schema: unknown, depth = 1): void {
	if (!isRecord(schema) || depth > AGX_JSON_SCHEMA_LIMITS.schemaDepth) {
		return;
	}
	for (const keyword of annotationKeywords) {
		if (
			Object.hasOwn(schema, keyword) &&
			boundedJsonValueProblem(schema[keyword])
		) {
			delete schema[keyword];
		}
	}
	if (isRecord(schema.properties)) {
		for (const child of Object.values(schema.properties)) {
			dropUnboundedAgxAnnotations(child, depth + 1);
		}
	}
	dropUnboundedAgxAnnotations(schema.items, depth + 1);
	dropUnboundedAgxAnnotations(schema.additionalProperties, depth + 1);
}

export function validateAgxJsonSchema(schema: unknown): string | null {
	try {
		return isRecord(schema)
			? validateSchemaNode(schema, 1, { nodes: 0, properties: 0 })
			: "schema must be an object";
	} catch {
		return "schema could not be validated safely";
	}
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return isRecord(value);
		case "array":
			return Array.isArray(value);
		case "number":
			return typeof value === "number";
		case "string":
			return typeof value === "string";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		default:
			return false;
	}
}

function childPath(path: string, key: string): string {
	return `${path}[${JSON.stringify(key)}]`;
}

function validatePayloadNode(
	schema: AgxJsonSchema,
	value: unknown,
	path: string,
): string | null {
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((type) => matchesType(value, type as string))) {
			return `${path}: expected ${types.join(" or ")}`;
		}
	}
	if (schema.const !== undefined && canonicalJson(value) !== canonicalJson(schema.const)) {
		return `${path}: does not match const`;
	}
	if (schema.enum !== undefined) {
		const serialized = canonicalJson(value);
		if (
			!(schema.enum as unknown[]).some(
				(candidate) => serialized === canonicalJson(candidate),
			)
		) {
			return `${path}: does not match enum`;
		}
	}

	if (typeof value === "string") {
		const length = [...value].length;
		if (schema.minLength !== undefined && length < (schema.minLength as number)) {
			return `${path}: shorter than minLength`;
		}
		if (schema.maxLength !== undefined && length > (schema.maxLength as number)) {
			return `${path}: longer than maxLength`;
		}
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < (schema.minimum as number)) {
			return `${path}: below minimum`;
		}
		if (schema.maximum !== undefined && value > (schema.maximum as number)) {
			return `${path}: above maximum`;
		}
		if (
			schema.exclusiveMinimum !== undefined &&
			value <= (schema.exclusiveMinimum as number)
		) {
			return `${path}: not above exclusiveMinimum`;
		}
		if (
			schema.exclusiveMaximum !== undefined &&
			value >= (schema.exclusiveMaximum as number)
		) {
			return `${path}: not below exclusiveMaximum`;
		}
		if (schema.multipleOf !== undefined) {
			const quotient = value / (schema.multipleOf as number);
			const tolerance =
				Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4;
			// An overflowing quotient would compare NaN > tolerance (false) and pass.
			if (
				!Number.isFinite(quotient) ||
				Math.abs(quotient - Math.round(quotient)) > tolerance
			) {
				return `${path}: not a multipleOf value`;
			}
		}
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < (schema.minItems as number)) {
			return `${path}: fewer than minItems`;
		}
		if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) {
			return `${path}: more than maxItems`;
		}
		if (
			schema.uniqueItems === true &&
			new Set(value.map(canonicalJson)).size !== value.length
		) {
			return `${path}: items are not unique`;
		}
		if (isRecord(schema.items)) {
			for (let index = 0; index < value.length; index += 1) {
				const problem = validatePayloadNode(
					schema.items,
					value[index],
					`${path}[${index}]`,
				);
				if (problem) {
					return problem;
				}
			}
		}
	}
	if (isRecord(value)) {
		const keys = Object.keys(value);
		if (schema.minProperties !== undefined && keys.length < (schema.minProperties as number)) {
			return `${path}: fewer than minProperties`;
		}
		if (schema.maxProperties !== undefined && keys.length > (schema.maxProperties as number)) {
			return `${path}: more than maxProperties`;
		}
		for (const required of (schema.required as string[] | undefined) ?? []) {
			if (!Object.hasOwn(value, required)) {
				return `${path}: missing required property ${JSON.stringify(required)}`;
			}
		}
		const properties = isRecord(schema.properties) ? schema.properties : {};
		for (const [key, child] of Object.entries(properties)) {
			if (Object.hasOwn(value, key)) {
				const problem = validatePayloadNode(
					child as AgxJsonSchema,
					value[key],
					childPath(path, key),
				);
				if (problem) {
					return problem;
				}
			}
		}
		for (const key of keys) {
			if (Object.hasOwn(properties, key)) {
				continue;
			}
			if (schema.additionalProperties === false) {
				return `${path}: additional property ${JSON.stringify(key)} is not allowed`;
			}
			if (isRecord(schema.additionalProperties)) {
				const problem = validatePayloadNode(
					schema.additionalProperties,
					value[key],
					childPath(path, key),
				);
				if (problem) {
					return problem;
				}
			}
		}
	}
	return null;
}

/** The value `JSON.stringify` puts on the wire, read back. `undefined` when
 * the wire leaves the value out (a bare `return;`, a function, a symbol). */
export function agxWireJson(
	value: unknown,
): { ok: true; value: unknown } | { ok: false; problem: string } {
	try {
		const text = JSON.stringify(value);
		return {
			ok: true,
			value: text === undefined ? undefined : JSON.parse(text),
		};
	} catch {
		return { ok: false, problem: "value cannot be encoded as JSON" };
	}
}

/** Validate `payload` as the JSON it becomes on the wire. A value the wire
 * leaves out is checked as `null`. */
export function validateAgxJsonPayload(
	schema: AgxJsonSchema,
	payload: unknown,
): string | null {
	const schemaProblem = validateAgxJsonSchema(schema);
	if (schemaProblem) {
		return `invalid schema: ${schemaProblem}`;
	}
	try {
		const wire = agxWireJson(payload);
		if (!wire.ok) {
			return `$: ${wire.problem}`;
		}
		const value = wire.value === undefined ? null : wire.value;
		const jsonProblem = boundedJsonValueProblem(value);
		if (jsonProblem) {
			return `$: ${jsonProblem}`;
		}
		return validatePayloadNode(schema, value, "$");
	} catch {
		return "$: payload could not be validated safely";
	}
}
