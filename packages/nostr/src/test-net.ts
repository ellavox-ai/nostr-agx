import net from "node:net";

/**
 * Small local servers for tests that need to see what actually reaches the
 * network. Both listen on a free port of the loopback interface only.
 */

const CONTROL = "agx-test-control";

/** Poll `check` until it holds, or fail after `timeoutMs`. */
export async function until(
	check: () => boolean,
	what: string,
	timeoutMs = 20_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export interface ConnectWatch {
	/** Attempts to open a socket to this port, on any address. */
	to(port: number): number;
	/** Every attempt to open a socket, to a port or to a local socket path. */
	readonly total: number;
	/** Attempts to a network port on any address: `total` without the local
	 * socket paths. */
	readonly network: number;
	stop(): void;
}

/**
 * Count the attempts this process makes to open a socket, from the moment of
 * the call until `stop()`. Every socket goes through `Socket.prototype.connect`:
 * `net.connect` for a plain address, `tls.connect` for `wss:`, and the HTTP
 * agents of both. Watching `net.connect` alone misses `wss:`. An attempt is
 * counted when it is made, not when a listener accepts it, so it does not
 * depend on timing. The attempt still goes ahead as usual.
 */
export function watchConnects(): ConnectWatch {
	const ports: (number | undefined)[] = [];
	const original = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
		// `net.connect` hands over its arguments already normalised, as an array.
		const first = Array.isArray(args[0]) ? args[0][0] : args[0];
		const options = typeof first === "object" && first !== null ? first : undefined;
		// A socket path wins over a port in the same options: Node ignores the port.
		const port = options
			? typeof (options as { path?: unknown }).path === "string"
				? undefined
				: (options as { port?: unknown }).port
			: first;
		const number = Number(port);
		ports.push(port === undefined || Number.isNaN(number) ? undefined : number);
		return (original as (...rest: unknown[]) => net.Socket).apply(this, args);
	} as typeof net.Socket.prototype.connect;
	return {
		to: (port) => ports.filter((seen) => seen === port).length,
		get total() {
			return ports.length;
		},
		get network() {
			return ports.filter((seen) => seen !== undefined).length;
		},
		stop() {
			net.Socket.prototype.connect = original;
		},
	};
}

function listen(server: net.Server): Promise<number> {
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve((server.address() as net.AddressInfo).port),
		),
	);
}

function closeAll(server: net.Server, sockets: Set<net.Socket>): Promise<void> {
	for (const socket of sockets) {
		socket.destroy();
	}
	return new Promise((resolve) => server.close(() => resolve()));
}

export interface TcpListener {
	readonly port: number;
	/**
	 * How many connections anything else made to this listener so far.
	 *
	 * A connection that was started earlier is accepted before one that is
	 * started later, so this makes a control connection of its own and waits
	 * until the listener has seen it. Whatever was dialed before the call is
	 * counted by then; no fixed sleep is needed.
	 */
	settle(): Promise<number>;
	close(): Promise<void>;
}

/** A TCP listener that stands in for a relay: it accepts and counts. */
export async function startTcpListener(): Promise<TcpListener> {
	let connections = 0;
	let controlSeen = false;
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		connections += 1;
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.on("data", (chunk) => {
			if (chunk.toString() === CONTROL) {
				controlSeen = true;
			}
		});
	});
	const port = await listen(server);
	return {
		port,
		async settle() {
			const control = net.connect(port, "127.0.0.1");
			control.on("error", () => {});
			control.on("connect", () => control.write(CONTROL));
			await until(() => controlSeen, "the control connection");
			control.destroy();
			return connections - 1;
		},
		close: () => closeAll(server, sockets),
	};
}

/** What a SOCKS5 CONNECT request asked the proxy to reach. */
export interface SocksRequest {
	type: "ipv4" | "ipv6" | "domain";
	host: string;
	port: number;
}

export interface FakeSocks5 {
	readonly port: number;
	/** Connections the proxy accepted, whether or not a request followed. */
	readonly connections: () => number;
	/** Every CONNECT request received, in order. */
	readonly requests: SocksRequest[];
	waitForRequests(count: number): Promise<SocksRequest[]>;
	close(): Promise<void>;
}

/**
 * A SOCKS5 server that accepts the no-authentication greeting, records the
 * destination of the CONNECT request, and answers "connection refused". It
 * never connects anywhere.
 */
export async function startFakeSocks5(): Promise<FakeSocks5> {
	let connections = 0;
	const requests: SocksRequest[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		connections += 1;
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		let pending = Buffer.alloc(0);
		let greeted = false;
		socket.on("data", (chunk: Buffer | string) => {
			pending = Buffer.concat([pending, Buffer.from(chunk)]);
			if (!greeted) {
				if (pending.length < 2 || pending.length < 2 + pending[1]!) {
					return;
				}
				pending = pending.subarray(2 + pending[1]!);
				greeted = true;
				socket.write(Buffer.from([5, 0]));
			}
			const request = parseConnectRequest(pending);
			if (request) {
				pending = Buffer.alloc(0);
				requests.push(request);
				socket.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
				socket.end();
			}
		});
	});
	const port = await listen(server);
	return {
		port,
		connections: () => connections,
		requests,
		async waitForRequests(count) {
			await until(() => requests.length >= count, `${count} SOCKS request(s)`);
			return requests;
		},
		close: () => closeAll(server, sockets),
	};
}

/** Parse VER CMD RSV ATYP ADDR PORT, or undefined while it is incomplete. */
function parseConnectRequest(data: Buffer): SocksRequest | undefined {
	if (data.length < 5) {
		return undefined;
	}
	const atyp = data[3];
	let hostEnd: number;
	let host: string;
	let type: SocksRequest["type"];
	if (atyp === 1) {
		type = "ipv4";
		hostEnd = 8;
		if (data.length < hostEnd + 2) return undefined;
		host = [...data.subarray(4, 8)].join(".");
	} else if (atyp === 3) {
		type = "domain";
		hostEnd = 5 + data[4]!;
		if (data.length < hostEnd + 2) return undefined;
		host = data.subarray(5, hostEnd).toString("utf8");
	} else if (atyp === 4) {
		type = "ipv6";
		hostEnd = 20;
		if (data.length < hostEnd + 2) return undefined;
		const groups: string[] = [];
		for (let offset = 4; offset < 20; offset += 2) {
			groups.push(data.readUInt16BE(offset).toString(16));
		}
		host = groups.join(":");
	} else {
		return undefined;
	}
	return { type, host, port: data.readUInt16BE(hostEnd) };
}
