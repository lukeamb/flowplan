import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { docToSnapshot, presenceState, type Snapshot, serializeSnapshot, setField, textField } from "@flowplan/core";
import type { FlowplanServer } from "@flowplan/server";
import type * as Y from "yjs";
import { sampleSnapshot } from "../../core/test/fixtures.ts";
import {
	type Client,
	connectClient,
	runCli,
	serverInfo,
	startTestServer,
	tempRoot,
	waitFor,
	writeFlow,
} from "./helpers.ts";

function draft(): Snapshot {
	return {
		schemaVersion: 1,
		blocks: [
			{ id: "d_mail", level: "architecture", parentId: null, title: "Mail", pseudocode: "", position: { x: 0, y: 0 } },
			{ id: "d_send", level: "service", parentId: "d_mail", title: "Sender", pseudocode: "", position: { x: 5, y: 5 } },
		],
		connections: [{ id: "d_c1", from: "d_mail", to: "d_send", label: "message" }],
	};
}

describe("CLI commands against a running server", () => {
	let root: string;
	let server: FlowplanServer;
	let client: Client;
	const live = () => docToSnapshot(client.doc);
	const block = (id: string) => live().blocks.find((b) => b.id === id);
	const cli = (...args: string[]) => runCli([...args, "--root", root]);

	before(async () => {
		root = tempRoot();
	});

	beforeEach(async () => {
		if (server) {
			client.close();
			await server.close();
		}
		root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		server = await startTestServer(root);
		client = await connectClient(server.port, server.token);
	});

	after(async () => {
		client.close();
		await server.close();
	});

	it("add-block adds a block to the live document and prints only its ID", async () => {
		const run = await cli(
			"add-block",
			"--level",
			"service",
			"--parent",
			"b_root",
			"--title",
			"Mailer",
			"--pseudocode",
			"queue mail",
			"--source",
			"src/mail.ts:3",
			"--x",
			"10",
			"--y",
			"20",
		);
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /^b_[A-Za-z0-9_-]+\n$/);
		const id = run.stdout.trim();
		await waitFor(() => block(id) !== undefined);
		assert.deepEqual(block(id), {
			id,
			level: "service",
			parentId: "b_root",
			title: "Mailer",
			pseudocode: "queue mail",
			position: { x: 10, y: 20 },
			source: "src/mail.ts:3",
		});
	});

	it("add-block refuses a function block as the parent, and changes nothing", async () => {
		const before = live();
		const run = await cli("add-block", "--level", "function", "--parent", "b_login", "--title", "x");
		assert.equal(run.code, 1);
		assert.match(run.stderr, /function/);
		assert.equal(run.stdout, "");
		assert.deepEqual(live(), before);
	});

	it("set changes one field in the live document and leaves the others", async () => {
		const run = await cli("set", "b_api", "title", "Gateway");
		assert.equal(run.code, 0, run.stderr);
		await waitFor(() => block("b_api")?.title === "Gateway");
		const expected = sampleSnapshot();
		const api = expected.blocks.find((b) => b.id === "b_api");
		assert.ok(api);
		api.title = "Gateway";
		assert.deepEqual(live(), expected);
	});

	it("set takes a value with newlines, a value that starts with '-' after '--', and a value from stdin", async () => {
		assert.equal((await cli("set", "b_api", "pseudocode", "line one\nline two")).code, 0);
		await waitFor(() => block("b_api")?.pseudocode === "line one\nline two");
		const dashed = await runCli(["set", "--root", root, "b_api", "title", "--", "-1 gateway"]);
		assert.equal(dashed.code, 0, dashed.stderr);
		await waitFor(() => block("b_api")?.title === "-1 gateway");
		const piped = await runCli(["set", "--root", root, "--stdin", "b_api", "pseudocode"], { stdin: "from\nstdin\n" });
		assert.equal(piped.code, 0, piped.stderr);
		await waitFor(() => block("b_api")?.pseudocode === "from\nstdin\n");
	});

	it("set parses position, parentId null, source null and meta JSON", async () => {
		assert.equal((await cli("set", "b_store", "position", "7,-8.5")).code, 0);
		assert.equal((await cli("set", "b_store", "parentId", "null")).code, 0);
		assert.equal((await cli("set", "b_api", "source", "null")).code, 0);
		assert.equal((await cli("set", "b_store", "meta", '{"tick":true}')).code, 0);
		assert.equal((await cli("set", "c_api_store", "label", "row")).code, 0);
		await waitFor(() => block("b_store")?.meta?.tick === true && live().connections[0]?.label === "row");
		assert.deepEqual(block("b_store")?.position, { x: 7, y: -8.5 });
		assert.equal(block("b_store")?.parentId, null);
		assert.equal(block("b_api")?.source, undefined);
	});

	it("set refuses a parentId that makes a cycle in the CLI's view, and changes nothing", async () => {
		const before = live();
		const run = await cli("set", "b_root", "parentId", "b_login");
		assert.equal(run.code, 1);
		assert.match(run.stderr, /cycle|function/);
		const cycle = await cli("set", "b_root", "parentId", "b_api");
		assert.equal(cycle.code, 1);
		assert.match(cycle.stderr, /cycle/);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(live(), before);
	});

	it("set refuses an unknown ID, an unknown field and a value that is not valid", async () => {
		for (const args of [
			["b_missing", "title", "x"],
			["b_api", "colour", "red"],
			["b_api", "level", "module"],
			["b_api", "position", "not a position"],
		]) {
			const run = await cli("set", ...args);
			assert.equal(run.code, 1, args.join(" "));
			assert.notEqual(run.stderr, "");
		}
	});

	it("connect adds a connection and prints only its ID", async () => {
		const run = await cli("connect", "b_store", "b_api", "--label", "row");
		assert.equal(run.code, 0, run.stderr);
		const id = run.stdout.trim();
		assert.match(run.stdout, /^c_[A-Za-z0-9_-]+\n$/);
		await waitFor(() => live().connections.some((c) => c.id === id));
		assert.deepEqual(
			live().connections.find((c) => c.id === id),
			{ id, from: "b_store", to: "b_api", label: "row" },
		);
	});

	it("delete removes a connection, and removes a block with its child canvas and its connections", async () => {
		assert.equal((await cli("delete", "c_api_store")).code, 0);
		await waitFor(() => live().connections.length === 0);
		assert.equal(live().blocks.length, 4);
		assert.equal((await cli("delete", "b_api")).code, 0);
		await waitFor(() => live().blocks.length === 2);
		assert.deepEqual(
			live().blocks.map((b) => b.id),
			["b_root", "b_store"],
		);
		assert.equal((await cli("delete", "b_api")).code, 1);
	});

	it("import adds every block and connection of the file in one transaction", async () => {
		const file = join(root, "draft.json");
		writeFileSync(file, serializeSnapshot(draft()));
		const batches: string[][] = [];
		client.doc.getMap("blocks").observe((event) => {
			const added = [...event.changes.keys].filter(([, change]) => change.action === "add").map(([id]) => id);
			if (added.length > 0) batches.push(added.sort());
		});
		const run = await cli("import", file);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout, "imported 2 blocks, 1 connection\n");
		await waitFor(() => batches.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(batches, [["d_mail", "d_send"]]);
		assert.deepEqual(
			live().blocks.filter((b) => b.id.startsWith("d_")),
			draft().blocks,
		);
		assert.deepEqual(
			live().connections.filter((c) => c.id.startsWith("d_")),
			draft().connections,
		);
	});

	it("import refuses a file with an ID that is already in the live document, and changes nothing", async () => {
		const clash = draft();
		const first = clash.blocks[0];
		assert.ok(first);
		first.id = "b_store";
		const second = clash.blocks[1];
		assert.ok(second);
		second.parentId = "b_store";
		const connection = clash.connections[0];
		assert.ok(connection);
		connection.from = "b_store";
		const file = join(root, "clash.json");
		writeFileSync(file, serializeSnapshot(clash));
		const before = live();
		const run = await cli("import", file);
		assert.equal(run.code, 1);
		assert.match(run.stderr, /b_store/);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(live(), before);
	});

	it("import refuses a file that is not valid before it contacts a server, and changes nothing", async () => {
		const broken = draft();
		const second = broken.blocks[1];
		assert.ok(second);
		second.level = "module" as "service";
		const file = join(root, "broken.json");
		writeFileSync(file, JSON.stringify(broken));
		const before = live();
		const run = await cli("import", file);
		assert.equal(run.code, 1);
		assert.match(run.stderr, /\$\.blocks\[1\]\.level/);
		assert.deepEqual(live(), before);

		const empty = tempRoot();
		const noServer = await runCli(["import", file, "--root", empty]);
		assert.equal(noServer.code, 1);
		assert.equal(existsSync(join(empty, ".flowplan")), false);
	});

	it("show prints each block's ID, level and title, and the connections, from the live document", async () => {
		client.close();
		await server.close();
		server = await startTestServer(root, 60_000);
		client = await connectClient(server.port, server.token);
		setField(client.doc, "ui", "b_api", "title", "Live title");
		await waitFor(() => textField(server.doc("main") as Y.Doc, "b_api", "title").toString() === "Live title");
		const run = await runCli(["show", "main", "--root", root]);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(
			run.stdout,
			[
				"flow main: 4 blocks, 1 connection",
				"b_root [architecture] Auth",
				"  b_api [service] Live title (src/api/server.ts:12)",
				"    b_login [function] login()",
				"  b_store [service] User store",
				"connections:",
				'  c_api_store: b_api -> b_store "user id"',
				"",
			].join("\n"),
		);
		assert.equal(readFileSync(join(root, ".flowplan", "main.json"), "utf8").includes("Live title"), false);
	});

	it("focus prints the canvas path and the titles of the selected blocks of the UI client", async () => {
		const none = await cli("focus");
		assert.equal(none.code, 0, none.stderr);
		assert.equal(none.stdout, "no focus: no UI client is connected to flow 'main'\n");

		const agent = await connectClient(server.port, server.token);
		agent.provider.awareness.setLocalState(
			presenceState({ kind: "agent", focus: { canvas: [], selected: ["b_store"] } }),
		);
		client.provider.awareness.setLocalState(
			presenceState({ kind: "ui", focus: { canvas: ["b_root", "b_api"], selected: ["b_login"] } }),
		);
		await waitFor(() => agent.provider.awareness.getStates().has(client.doc.clientID));
		const run = await cli("focus");
		agent.close();
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout, "canvas: Top › Auth › API service\nselected: login() (b_login)\n");
	});
});

describe("CLI commands that need no server", () => {
	it("validate exits with code 0 for a valid file and starts no server", async () => {
		const root = tempRoot();
		const file = join(root, "ok.json");
		writeFileSync(file, serializeSnapshot(sampleSnapshot()));
		const run = await runCli(["validate", file, "--root", root]);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout, "valid: 4 blocks, 1 connection\n");
		assert.equal(serverInfo(root), undefined);
		assert.equal(existsSync(join(root, ".flowplan")), false);
	});

	it("validate exits with a non-zero code and prints the JSON path of each error for a file that is not valid", async () => {
		const root = tempRoot();
		const broken = sampleSnapshot() as unknown as { blocks: Record<string, unknown>[] };
		const first = broken.blocks[0];
		const second = broken.blocks[1];
		assert.ok(first && second);
		first.title = 5;
		second.parentId = "b_missing";
		const file = join(root, "bad.json");
		writeFileSync(file, JSON.stringify(broken));
		const run = await runCli(["validate", file]);
		assert.equal(run.code, 1);
		assert.match(run.stderr, /^\$\.blocks\[0\]\.title: /m);
		const again = await runCli(["validate", join(root, "missing.json")]);
		assert.equal(again.code, 1);
		assert.match(again.stderr, /missing\.json/);
		writeFileSync(file, "{ nope");
		assert.match((await runCli(["validate", file])).stderr, /^\$: not valid JSON/m);
		const parentOnly = sampleSnapshot();
		const login = parentOnly.blocks[1];
		assert.ok(login);
		login.parentId = "b_missing";
		writeFileSync(file, JSON.stringify(parentOnly));
		assert.match((await runCli(["validate", file])).stderr, /^\$\.blocks\[1\]\.parentId: /m);
	});

	it("show reads the snapshot file when no server runs, and starts no server", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const run = await runCli(["show"], { cwd: root });
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /^flow main: 4 blocks, 1 connection\n/);
		assert.equal(serverInfo(root), undefined);
		const missing = await runCli(["show", "other"], { cwd: root });
		assert.equal(missing.code, 1);
		assert.match(missing.stderr, /no flow 'other'/);
	});

	it("focus says that no server runs, and starts no server", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const run = await runCli(["focus", "--root", root]);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout, "no focus: the flowplan server is not running\n");
		assert.equal(serverInfo(root), undefined);
	});
});
