import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import type { FlowplanServer } from "../src/index.ts";
import { connect, disconnect, start, tempRoot } from "./helpers.ts";

type Attempt = { status: number | "open" };

function upgrade(
	server: FlowplanServer,
	options: { path?: string; headers?: Record<string, string> },
): Promise<Attempt> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}${options.path ?? "/main"}`, {
			headers: options.headers ?? {},
		});
		socket.on("open", () => {
			socket.close();
			resolve({ status: "open" });
		});
		socket.on("unexpected-response", (_req, res) => {
			res.resume();
			resolve({ status: res.statusCode ?? 0 });
			socket.terminate();
		});
		socket.on("error", (error) => {
			if (!/Unexpected server response/.test(error.message)) reject(error);
		});
	});
}

function get(server: FlowplanServer, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: server.port, path: "/", headers }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("server security", () => {
	let server: FlowplanServer;
	const own = () => `http://127.0.0.1:${server.port}`;
	const tokenPath = (flow = "main") => `/${flow}?token=${server.token}`;

	before(async () => {
		({ server } = await start({ root: tempRoot(), allowedOrigins: ["http://localhost:5173"] }));
	});
	after(async () => server.close());

	it("listens on 127.0.0.1 only", () => {
		assert.deepEqual(server.address(), { address: "127.0.0.1", family: "IPv4", port: server.port });
	});

	it("accepts a websocket from the app's own origin with the token", async () => {
		assert.deepEqual(await upgrade(server, { path: tokenPath(), headers: { Origin: own() } }), { status: "open" });
		const viaLocalhost = { Origin: `http://localhost:${server.port}`, Host: `localhost:${server.port}` };
		assert.deepEqual(await upgrade(server, { path: tokenPath(), headers: viaLocalhost }), { status: "open" });
	});

	it("accepts a websocket from an extra allowed origin with the token", async () => {
		const attempt = await upgrade(server, { path: tokenPath(), headers: { Origin: "http://localhost:5173" } });
		assert.deepEqual(attempt, { status: "open" });
	});

	it("refuses a websocket from the app's own origin with no token or a wrong token", async () => {
		assert.deepEqual(await upgrade(server, { headers: { Origin: own() } }), { status: 401 });
		assert.deepEqual(await upgrade(server, { path: "/main?token=wrong", headers: { Origin: own() } }), { status: 401 });
	});

	it("refuses a websocket with an Origin that is not the app's own origin", async () => {
		for (const origin of ["https://evil.example", "http://127.0.0.1:1", "null", `https://127.0.0.1:${server.port}`]) {
			assert.deepEqual(await upgrade(server, { headers: { Origin: origin } }), { status: 403 }, origin);
		}
	});

	it("refuses a websocket with a foreign Origin even when it sends the token", async () => {
		const attempt = await upgrade(server, { path: tokenPath(), headers: { Origin: "https://evil.example" } });
		assert.deepEqual(attempt, { status: 403 });
	});

	it("refuses a websocket with a Host that is not localhost or 127.0.0.1 with the server's port", async () => {
		for (const host of [
			"evil.example",
			`evil.example:${server.port}`,
			"127.0.0.1:1",
			"localhost",
			`[::1]:${server.port}`,
		]) {
			const attempt = await upgrade(server, { path: tokenPath(), headers: { Host: host } });
			assert.deepEqual(attempt, { status: 403 }, host);
		}
	});

	it("refuses an HTTP request with a Host that is not localhost or 127.0.0.1 with the server's port", async () => {
		assert.equal(await get(server, { Host: `rebind.example:${server.port}` }), 403);
		assert.notEqual(await get(server, { Host: `127.0.0.1:${server.port}` }), 403);
	});

	it("refuses a websocket with no Origin and no token", async () => {
		assert.deepEqual(await upgrade(server, {}), { status: 401 });
	});

	it("refuses a websocket with no Origin and a wrong token", async () => {
		const wrong = `${server.token.slice(0, -1)}${server.token.endsWith("A") ? "B" : "A"}`;
		assert.deepEqual(await upgrade(server, { path: `/main?token=${wrong}` }), { status: 401 });
		assert.deepEqual(await upgrade(server, { path: "/main?token=" }), { status: 401 });
	});

	it("accepts a websocket with no Origin and the token from server.json", async () => {
		assert.deepEqual(await upgrade(server, { path: tokenPath() }), { status: "open" });
		const client = await connect(server, "main");
		disconnect(client);
	});

	it("refuses a flow name that is not safe as a file name", async () => {
		for (const flow of ["server", "..%2Fsecret", "a.b", "%2E%2E", ""]) {
			assert.deepEqual(await upgrade(server, { path: tokenPath(flow) }), { status: 400 }, flow);
		}
	});
});
