import WebSocket from "ws";

/** Whether a relay accepts a WebSocket connection within `timeoutMs`. */
export function probeRelay(url: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch {
			resolve(false);
			return;
		}
		let settled = false;
		const finish = (reachable: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.terminate();
			resolve(reachable);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		socket.once("open", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
