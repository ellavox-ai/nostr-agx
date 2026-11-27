import WebSocket from "ws";

/**
 * Whether a relay accepts a WebSocket connection within `timeoutMs`. Pass a
 * transport's own WebSocket class to probe through the same relay proxy.
 */
export function probeRelay(
	url: string,
	timeoutMs: number,
	WebSocketClass: typeof WebSocket = WebSocket,
): Promise<boolean> {
	return new Promise((resolve) => {
		let socket: WebSocket;
		try {
			socket = new WebSocketClass(url);
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
