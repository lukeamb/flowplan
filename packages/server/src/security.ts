import { timingSafeEqual } from "node:crypto";

export type Gate = { port: number; token: string; allowedOrigins: readonly string[] };
export type Verdict = { ok: true } | { ok: false; status: 400 | 401 | 403; reason: string };

export function ownOrigins(port: number): string[] {
	return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

export function hostAllowed(host: string | undefined, port: number): boolean {
	if (!host) return false;
	const value = host.toLowerCase();
	return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

function tokenMatches(given: string | null, expected: string): boolean {
	if (!given) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function checkHttp(headers: { host?: string | undefined }, gate: Gate): Verdict {
	return hostAllowed(headers.host, gate.port)
		? { ok: true }
		: { ok: false, status: 403, reason: "Host header is not localhost or 127.0.0.1 with the server's port" };
}

export function checkUpgrade(
	headers: { host?: string | undefined; origin?: string | undefined },
	token: string | null,
	gate: Gate,
): Verdict {
	const host = checkHttp(headers, gate);
	if (!host.ok) return host;
	if (headers.origin !== undefined && ![...ownOrigins(gate.port), ...gate.allowedOrigins].includes(headers.origin)) {
		return { ok: false, status: 403, reason: "Origin is not the app's own origin" };
	}
	return tokenMatches(token, gate.token) ? { ok: true } : { ok: false, status: 401, reason: "no valid token" };
}
