/**
 * A proxy URL that is safe to print or log: any user name and password are
 * replaced. The SOCKS5 proxy the launcher opens has a user name and password
 * made for each run, and together they let anything on this machine use the
 * node's tailnet identity.
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
