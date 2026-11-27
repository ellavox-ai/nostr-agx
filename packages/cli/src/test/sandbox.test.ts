import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

/**
 * `agx serve` adds a SIGINT and a SIGTERM listener on every run and never takes
 * them off (a real run is one per process). A test file that starts it more than
 * ten times in one process would make Node warn of a possible memory leak, so
 * `restore()` takes off what a test added.
 */
describe("sandbox", () => {
	it("restore() takes off the signal listeners added since it was made and keeps the ones already there", () => {
		const already = () => undefined;
		const added = () => undefined;
		process.on("SIGTERM", already);
		const box = sandbox();
		process.on("SIGINT", added);
		process.on("SIGTERM", added);
		try {
			box.restore();
			expect(process.listeners("SIGINT")).not.toContain(added);
			expect(process.listeners("SIGTERM")).not.toContain(added);
			expect(process.listeners("SIGTERM")).toContain(already);
		} finally {
			process.removeListener("SIGINT", added);
			process.removeListener("SIGTERM", added);
			process.removeListener("SIGTERM", already);
		}
	});
});
