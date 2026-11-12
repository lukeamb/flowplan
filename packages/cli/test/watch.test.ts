import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { presenceState, setField } from "@flowplan/core";
import type { FlowplanServer } from "@flowplan/server";
import { sampleSnapshot } from "../../core/test/fixtures.ts";
import { CLI, type Client, connectClient, runCli, startTestServer, tempRoot, waitFor, writeFlow } from "./helpers.ts";

type Watch = {
	child: ChildProcessWithoutNullStreams;
	lines: string[];
	events: () => Record<string, unknown>[];
	stderr: () => string;
	exited: Promise<number | null>;
};

function watch(root: string): Watch {
	const child = spawn(process.execPath, [CLI, "watch", "--root", root], { stdio: ["pipe", "pipe", "pipe"] });
	const lines: string[] = [];
	let buffer = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		lines.push(...parts);
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	exited.then(() => clearTimeout(timer));
	return {
		child,
		lines,
		events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
		stderr: () => stderr,
		exited,
	};
}

describe("flowplan watch", () => {
	let root: string;
	let server: FlowplanServer;
	let ui: Client;
	let watcher: Watch;

	beforeEach(async () => {
		root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		server = await startTestServer(root);
		ui = await connectClient(server.port, server.token);
		watcher = watch(root);
		await waitFor(() => watcher.stderr().includes("watching flow 'main'"), 10_000);
	});

	afterEach(async () => {
		watcher.child.kill("SIGTERM");
		await watcher.exited;
		ui.close();
		await server.close();
	});

	it("prints one JSON object on each line, and emits a UI edit with origin ui within 1 second", async () => {
		const edited = Date.now();
		setField(ui.doc, "ui", "b_api", "title", "Renamed by the user");
		const waited = await waitFor(() => watcher.lines.length > 0, 1000);
		assert.ok(Date.now() - edited <= 1000, `${waited} ms`);
		for (const line of watcher.lines) assert.equal(typeof JSON.parse(line), "object");
		const [event] = watcher.events();
		assert.equal(event?.type, "edit");
		assert.equal(event?.origin, "ui");
		assert.equal(event?.flow, "main");
		assert.deepEqual(event?.changes, [
			{
				kind: "block",
				id: "b_api",
				action: "update",
				fields: ["title"],
				item: {
					id: "b_api",
					level: "service",
					parentId: "b_root",
					title: "Renamed by the user",
					pseudocode: "receive request\nvalidate token",
					position: { x: 120, y: 40.5 },
					source: "src/api/server.ts:12",
				},
			},
		]);
	});

	it("emits a focus event with origin ui when the user's focus changes", async () => {
		ui.provider.awareness.setLocalState(
			presenceState({ kind: "ui", focus: { canvas: ["b_root"], selected: ["b_api"] } }),
		);
		await waitFor(() => watcher.events().some((e) => e.type === "focus"), 1000);
		const focus = watcher.events().find((e) => e.type === "focus");
		assert.deepEqual(focus && { ...focus, at: undefined, client: undefined }, {
			type: "focus",
			origin: "ui",
			flow: "main",
			at: undefined,
			client: undefined,
			canvas: [{ id: "b_root", title: "Auth" }],
			selected: [{ id: "b_api", title: "API service" }],
		});
		ui.provider.awareness.setLocalState(
			presenceState({ kind: "ui", focus: { canvas: ["b_root"], selected: ["b_api"] } }),
		);
		ui.provider.awareness.setLocalState(
			presenceState({ kind: "ui", focus: { canvas: ["b_root", "b_api"], selected: [] } }),
		);
		await waitFor(() => watcher.events().filter((e) => e.type === "focus").length === 2, 1000);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(watcher.events().filter((e) => e.type === "focus").length, 2);
	});

	it("gives every event an origin, and emits one agent event for one agent command", async () => {
		const run = await runCli(["set", "b_store", "title", "Store", "--root", root]);
		assert.equal(run.code, 0, run.stderr);
		await waitFor(() => watcher.lines.length > 0, 1000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const events = watcher.events();
		assert.equal(events.length, 1, watcher.lines.join("\n"));
		assert.equal(events[0]?.origin, "agent");
		ui.provider.awareness.setLocalState(presenceState({ kind: "ui", focus: { canvas: [], selected: [] } }));
		setField(ui.doc, "ui", "b_api", "title", "again");
		await waitFor(() => watcher.lines.length >= 3, 1000);
		for (const event of watcher.events()) assert.ok(["ui", "agent", "server"].includes(event.origin as string));
	});

	it("exits with code 0 on SIGTERM", async () => {
		watcher.child.kill("SIGTERM");
		assert.equal(await watcher.exited, 0);
	});

	it("exits with a non-zero code when the connection to the server closes", async () => {
		await server.close();
		assert.equal(await watcher.exited, 1);
		assert.match(watcher.stderr(), /connection to the flowplan server closed/);
	});
});
