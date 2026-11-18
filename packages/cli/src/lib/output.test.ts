import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../test/helpers.js";
import { json, setJsonMode } from "./output.js";

beforeEach(() => {
	setJsonMode(true);
});

afterEach(() => {
	setJsonMode(false);
});

/** U+007F (DEL), U+0085 (NEL), U+009B (CSI in some terminals), U+2028, U+2029. */
const RAW = ["\u007f", "\u0085", "\u009b", "\u2028", "\u2029"];

describe("json()", () => {
	it("escapes C1 controls, DEL and line separators and stays lossless", async () => {
		const payload = {
			org: "Acme\u009b31mRED",
			nested: [{ description: "a\u007fb\u0085c\u2028d\u2029e" }],
			"key\u009b": "plain",
			plain: "ünïcödé — ok",
		};

		const { stdout } = await capture(async () => json(payload));

		for (const ch of RAW) {
			expect(stdout).not.toContain(ch);
		}
		expect(stdout).toContain("\\u009b");
		expect(JSON.parse(stdout)).toEqual(payload);
	});

	it("escapes the bidirectional formatting controls and stays lossless", async () => {
		const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((code) =>
			String.fromCharCode(code),
		);
		const payload = {
			subject: `invoice ${bidi.join("")} total`,
			nested: [{ text: `a${bidi[4]}b${bidi[7]}c` }],
			[`key${bidi[3]}`]: "plain",
		};

		const { stdout } = await capture(async () => json(payload));

		for (const ch of bidi) {
			expect(stdout).not.toContain(ch);
		}
		expect(stdout).toContain("\\u202e");
		expect(stdout).toContain("\\u2069");
		expect(JSON.parse(stdout)).toEqual(payload);
	});

	it("leaves ordinary text in other scripts unescaped", async () => {
		const payload = {
			french: "10\u202f000 \u20ac caf\u00e9",
			hebrew: "\u05e9\u05dc\u05d5\u05dd",
			arabic: "\u0645\u0631\u062d\u0628\u0627",
			cjk: "\u4f60\u597d \u3053\u3093\u306b\u3061\u306f",
			emoji: "\ud83d\ude42 \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67",
		};

		const { stdout } = await capture(async () => json(payload));

		for (const value of Object.values(payload)) {
			expect(stdout).toContain(value);
		}
		expect(JSON.parse(stdout)).toEqual(payload);
	});
});
