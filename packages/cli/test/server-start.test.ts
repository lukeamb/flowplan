import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { docToSnapshot } from "@flowplan/core";
import { sampleSnapshot } from "../../core/test/fixtures.ts";
import { serverUrl } from "../src/index.ts";
import {
	connectClient,
	isRunning,
	runCli,
	serverInfo,
	serverProcesses,
	startTestServer,
	stopSpawnedServers,
	tempRoot,
	writeFlow,
} from "./helpers.ts";

const addBlock = (root: string, title: string) =>
	runCli(["add-block", "--root", root, "--level", "architecture", "--title", title]);

describe("server start from an edit command", () => {
	it("starts the server when it is not running, and the edit reaches it", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		try {
			const run = await addBlock(root, "Billing");
			assert.equal(run.code, 0, run.stderr);
			const id = run.stdout.trim();
			assert.match(id, /^b_[A-Za-z0-9_-]+$/);
			const info = serverInfo(root);
			assert.ok(info && isRunning(info.pid) && info.pid !== process.pid);
			assert.deepEqual(serverProcesses(root), [info.pid]);
			const client = await connectClient(info.port, info.token);
			assert.equal(docToSnapshot(client.doc).blocks.find((b) => b.id === id)?.title, "Billing");
			client.close();
		} finally {
			await stopSpawnedServers(root);
		}
	});

	it("starts a new server and succeeds when server.json names a process that is not running", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		writeFileSync(
			join(root, ".flowplan", "server.json"),
			JSON.stringify({ pid: 2 ** 22 + 4321, port: 1, token: "old" }),
		);
		try {
			const run = await addBlock(root, "Billing");
			assert.equal(run.code, 0, run.stderr);
			const info = serverInfo(root);
			assert.ok(info && isRunning(info.pid) && info.token !== "old");
		} finally {
			await stopSpawnedServers(root);
		}
	});

	it("runs exactly one server when two edit commands start at the same time, and both succeed", async () => {
		for (let round = 0; round < 3; round++) {
			const root = tempRoot();
			await writeFlow(root, "main", sampleSnapshot());
			try {
				const [first, second] = await Promise.all([addBlock(root, "One"), addBlock(root, "Two")]);
				assert.equal(first.code, 0, first.stderr);
				assert.equal(second.code, 0, second.stderr);
				const info = serverInfo(root);
				assert.ok(info);
				assert.deepEqual(serverProcesses(root), [info.pid]);
				const client = await connectClient(info.port, info.token);
				const titles = docToSnapshot(client.doc).blocks.map((b) => b.title);
				assert.ok(titles.includes("One") && titles.includes("Two"), titles.join());
				client.close();
				assert.equal(readdirSync(join(root, ".flowplan")).includes("server.lock"), false);
			} finally {
				await stopSpawnedServers(root);
			}
		}
	});

	it("exits with a non-zero code and leaves the snapshot unchanged when the server cannot start", async () => {
		const root = tempRoot();
		const path = await writeFlow(root, "main", sampleSnapshot());
		const before = readFileSync(path, "utf8");
		symlinkSync(join(tempRoot(), "elsewhere"), join(root, ".flowplan", ".gitignore"));
		const run = await addBlock(root, "Billing");
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /\.gitignore/);
		assert.equal(readFileSync(path, "utf8"), before);
		assert.equal(serverInfo(root), undefined);
	});

	it("exits with a non-zero code, shows the server's error and leaves the snapshot unchanged when the spawned server fails", async () => {
		const root = tempRoot();
		const path = await writeFlow(root, "main", sampleSnapshot());
		const before = readFileSync(path, "utf8");
		mkdirSync(join(root, ".flowplan", "server.json"));
		try {
			const run = await addBlock(root, "Billing");
			assert.notEqual(run.code, 0);
			assert.match(run.stderr, /did not start/);
			assert.equal(readFileSync(path, "utf8"), before);
		} finally {
			await stopSpawnedServers(root);
		}
		assert.deepEqual(serverProcesses(root), []);
	});

	it("exits with a non-zero code and never prints the token when server.json names a process that is not a flowplan server", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const token = "secret-token-that-must-not-print";
		writeFileSync(join(root, ".flowplan", "server.json"), JSON.stringify({ pid: process.pid, port: 1, token }));
		const run = await addBlock(root, "Billing");
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /could not open flow 'main'/);
		assert.equal(run.stdout.includes(token) || run.stderr.includes(token), false);
		assert.ok(run.ms < 10_000);
	});
});

describe("connection address", () => {
	it("connects to 127.0.0.1 with the port from server.json, never to localhost", async () => {
		assert.equal(serverUrl(4242), "ws://127.0.0.1:4242");
		const sources = readdirSync(new URL("../src/", import.meta.url));
		for (const file of sources) {
			const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
			assert.equal(text.includes("localhost"), false, file);
		}
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const server = await startTestServer(root);
		try {
			const run = await addBlock(root, "Via the token");
			assert.equal(run.code, 0, run.stderr);
			assert.deepEqual(serverProcesses(root), []);
		} finally {
			await server.close();
		}
	});
});
