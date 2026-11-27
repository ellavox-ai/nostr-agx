/**
 * A proxy URL that is safe to print or log: any user name and password are
 * replaced. A SOCKS5 proxy started for one run (a Tailscale node's, for
 * example) has a user name and password made for that run, and together they
 * let anything on this machine use the proxy.
 */
export function redactProxyUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) {
			return url;
		}
		parsed.username = "redacted";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return "[redacted proxy URL]";
	}
}
