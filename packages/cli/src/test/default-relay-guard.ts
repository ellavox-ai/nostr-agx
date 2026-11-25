import net from "node:net";
import { afterEach } from "vitest";

/**
 * Refuses connections to chosen TCP ports for the rest of the process, the way
 * a closed port does (ECONNREFUSED, before a byte is sent), and remembers each
 * refusal so the test that made it can be failed. Every outgoing connection
 * goes through `net.Socket.prototype.connect` (`ws`, `fetch`, `net.connect`),
 * so one wrapper there covers them all.
 */

export interface PortGuard {
	ports: ReadonlySet<number>;
	/** Throws, naming the targets, if anything was refused since the last call. */
	assertNoneRefused(): void;
	/** Puts back the `connect` this guard replaced. Restore in reverse order. */
	restore(): void;
}

const active = new Set<PortGuard>();

/** Every port some guard in this process refuses right now. */
export function guardedPorts(): number[] {
	return [...active].flatMap((guard) => [...guard.ports]);
}

/** Where a `socket.connect(...)` call is aimed; null when it names no port
 * (a unix socket path has none: its `port` reads as NaN, which is never guarded). */
function targetOf(args: unknown[]): { host: string; port: number } | null {
	// `net.connect()` calls `socket.connect()` with its own `[options, callback]`.
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (typeof first === "object" && first !== null) {
		const { host, port } = first as { host?: string; port?: number | string };
		return { host: host ?? "localhost", port: Number(port) };
	}
	if (typeof first === "number") {
		return {
			host: typeof args[1] === "string" ? args[1] : "localhost",
			port: first,
		};
	}
	return null;
}

export function refuseConnections(ports: readonly number[]): PortGuard {
	const blocked = new Set(ports);
	const original = net.Socket.prototype.connect;
	const refused: string[] = [];
	net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
		const target = targetOf(args);
		if (target === null || !blocked.has(target.port)) {
			return (original as (...a: unknown[]) => net.Socket).apply(this, args);
		}
		refused.push(`${target.host}:${target.port}`);
		const error = Object.assign(
			new Error(`connect ECONNREFUSED ${target.host}:${target.port}`),
			{ code: "ECONNREFUSED", syscall: "connect", address: target.host, port: target.port },
		);
		process.nextTick(() => this.destroy(error));
		return this;
	} as typeof net.Socket.prototype.connect;
	const guard: PortGuard = {
		ports: blocked,
		assertNoneRefused: () => {
			const hits = refused.splice(0);
			if (hits.length > 0) {
				throw new Error(
					`This test tried to connect to ${hits.join(", ")}, the default relay port. The connection was refused: a relay that happens to run there would otherwise have answered, and the result would depend on the machine. Give the profile relays of its own, for example updateProfile("default", { relays: [] }), or the address of a relay the test starts on port 0.`,
				);
			}
		},
		restore: () => {
			net.Socket.prototype.connect = original;
			active.delete(guard);
		},
	};
	active.add(guard);
	return guard;
}

/** {@link refuseConnections}, and every test that connected to `ports` fails. */
export function failTestsThatConnect(ports: readonly number[]): PortGuard {
	const guard = refuseConnections(ports);
	afterEach(() => guard.assertNoneRefused());
	return guard;
}
