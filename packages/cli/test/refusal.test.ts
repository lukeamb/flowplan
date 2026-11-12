import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addBlock } from "@flowplan/core";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocketServer } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { sampleSnapshot } from "../../core/test/fixtures.ts";
import { CliError, openFlow } from "../src/index.ts";
import { runCli, startTestServer, tempRoot, writeFlow } from "./helpers.ts";

type Behaviour = "terminate" | "refuse";

async function fakeServer(behaviour: Behaviour): Promise<{ http: Server; port: number }> {
	const http = createServer();
	const wss = new WebSocketServer({ server: http });
	const doc = new Y.Doc();
	wss.on("connection", (socket) => {
		const step1 = encoding.createEncoder();
		encoding.writeVarUint(step1, 0);
		syncProtocol.writeSyncStep1(step1, doc);
		socket.send(encoding.toUint8Array(step1));
		socket.on("message", (data: Buffer) => {
			const decoder = decoding.createDecoder(new Uint8Array(data));
			if (decoding.readVarUint(decoder) !== 0) return;
			const peek = decoding.createDecoder(new Uint8Array(data));
			decoding.readVarUint(peek);
			if (decoding.readVarUint(peek) === syncProtocol.messageYjsUpdate) {
				if (behaviour === "terminate") socket.terminate();
				else socket.close(1011, "the server refused the edit");
				return;
			}
			const reply = encoding.createEncoder();
			encoding.writeVarUint(reply, 0);
			syncProtocol.readSyncMessage(decoder, reply, doc, null);
			if (encoding.length(reply) > 1) socket.send(encoding.toUint8Array(reply));
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	return { http, port: (http.address() as AddressInfo).port };
}

function pointAt(root: string, port: number): void {
	writeFileSync(join(root, ".flowplan", "server.json"), JSON.stringify({ pid: process.pid, port, token: "t" }));
}

describe("an edit that the server does not apply", () => {
	it("exits 1 with the reason when the server stops after it receives the edit and before the close", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const fake = await fakeServer("terminate");
		pointAt(root, fake.port);
		try {
			const run = await runCli(["add-block", "--root", root, "--level", "architecture", "--title", "lost"]);
			assert.equal(run.code, 1);
			assert.match(run.stderr, /the flowplan server did not apply the edit/);
			assert.match(run.stderr, /1006/);
			assert.equal(run.stdout, "");
		} finally {
			fake.http.closeAllConnections();
			fake.http.close();
		}
	});

	it("exits 1 with the server's reason when the server refuses the frame", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const fake = await fakeServer("refuse");
		pointAt(root, fake.port);
		try {
			const run = await runCli(["add-block", "--root", root, "--level", "service", "--title", "refused"]);
			assert.equal(run.code, 1);
			assert.match(run.stderr, /1011/);
			assert.match(run.stderr, /the server refused the edit/);
		} finally {
			fake.http.closeAllConnections();
			fake.http.close();
		}
	});

	it("close() rejects when the server closed the connection before the close", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const server = await startTestServer(root);
		const connection = await openFlow({ pid: process.pid, port: server.port, token: server.token }, "main");
		await server.close();
		addBlock(connection.doc, "agent", { level: "architecture", title: "after the stop" });
		await assert.rejects(connection.close(), (error: unknown) => {
			assert.ok(error instanceof CliError);
			assert.match(error.message, /did not apply the edit/);
			return true;
		});
	});
});
