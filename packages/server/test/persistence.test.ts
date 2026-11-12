import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addBlock, deleteItem, docToSnapshot, parseSnapshot, serializeSnapshot, setField } from "@flowplan/core";
import { WebSocket } from "ws";
import type * as Y from "yjs";
import { sampleSnapshot } from "../../core/test/fixtures.ts";
import { startServer } from "../src/index.ts";
import { connect, disconnect, start, tempRoot, waitFor, writeFlow } from "./helpers.ts";

const fileText = (root: string, flow: string) => readFileSync(join(root, ".flowplan", `${flow}.json`), "utf8");

describe("loading at start", () => {
	it("loads each flow from its snapshot under .flowplan/", async () => {
		const root = tempRoot();
		const other = sampleSnapshot();
		other.blocks = other.blocks.filter((b) => b.id === "b_root");
		other.connections = [];
		await writeFlow(root, "main", sampleSnapshot());
		await writeFlow(root, "billing", other);
		const { server } = await start({ root });
		try {
			assert.deepEqual(server.flowNames(), ["billing", "main"]);
			assert.deepEqual(docToSnapshot(server.doc("main") as Y.Doc), sampleSnapshot());
			const client = await connect(server, "billing");
			assert.deepEqual(docToSnapshot(client.doc), other);
			disconnect(client);
		} finally {
			await server.close();
		}
	});

	it("reports an error for a snapshot that is not valid and does not load that flow", async () => {
		const root = tempRoot();
		const broken = sampleSnapshot();
		const block = broken.blocks[0];
		assert.ok(block);
		block.parentId = "b_missing";
		await writeFlow(root, "main", sampleSnapshot());
		await writeFlow(root, "broken", serializeSnapshot(broken));
		await writeFlow(root, "garbled", "{ not json");
		const { server, logged } = await start({ root });
		try {
			assert.deepEqual(server.flowNames(), ["main"]);
			assert.equal(server.doc("broken"), undefined);
			assert.ok(
				logged.some((line) => line.includes("broken") && line.includes("$.blocks[0].parentId")),
				logged.join("\n"),
			);
			assert.ok(
				logged.some((line) => line.includes("garbled") && line.includes("not valid JSON")),
				logged.join("\n"),
			);
		} finally {
			await server.close();
		}
	});

	it("refuses a client for a flow that did not load, and never changes its file", async () => {
		const root = tempRoot();
		const path = await writeFlow(root, "broken", "{ not json");
		const { server } = await start({ root, debounceMs: 20 });
		try {
			const status = await new Promise<number>((resolve) => {
				const socket = new WebSocket(`ws://127.0.0.1:${server.port}/broken?token=${server.token}`);
				socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
				socket.on("error", () => {});
			});
			assert.equal(status, 409);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(readFileSync(path, "utf8"), "{ not json");
		} finally {
			await server.close();
		}
		assert.equal(readFileSync(path, "utf8"), "{ not json");
	});

	it("skips a file whose name is not a safe flow name, and temporary files", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		await writeFlow(root, "has.dot", sampleSnapshot());
		await writeFlow(root, ".main.json.123.tmp", sampleSnapshot());
		const { server } = await start({ root });
		try {
			assert.deepEqual(server.flowNames(), ["main"]);
		} finally {
			await server.close();
		}
	});
});

describe("restart", () => {
	it("gives a live document equal to the last snapshot after the server stops and starts again", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const first = await start({ root });
		const client = await connect(first.server, "main");
		addBlock(client.doc, "agent", { id: "b_mail", level: "service", parentId: "b_root", title: "Mailer" });
		setField(client.doc, "ui", "b_api", "pseudocode", "new body");
		deleteItem(client.doc, "ui", "c_api_store");
		const expected = docToSnapshot(client.doc);
		await waitFor(
			() =>
				first.server.doc("main") !== undefined && docToSnapshot(first.server.doc("main") as Y.Doc).blocks.length === 5,
		);
		disconnect(client);
		await first.server.close();

		const saved = parseSnapshot(fileText(root, "main"));
		assert.ok(saved.ok);
		assert.deepEqual(saved.snapshot, expected);

		const second = await start({ root });
		try {
			const fresh = await connect(second.server, "main");
			assert.deepEqual(docToSnapshot(fresh.doc), saved.snapshot);
			assert.deepEqual(docToSnapshot(second.server.doc("main") as Y.Doc), saved.snapshot);
			disconnect(fresh);
		} finally {
			await second.server.close();
		}
	});
});

describe("snapshot writes", () => {
	it("makes the snapshot on disk equal the live document within 2 seconds after edits stop", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server } = await start({ root });
		const client = await connect(server, "main");
		try {
			setField(client.doc, "agent", "b_api", "title", "Gateway");
			const waited = await waitFor(
				() =>
					fileText(root, "main") === serializeSnapshot(docToSnapshot(server.doc("main") as Y.Doc)) &&
					fileText(root, "main").includes("Gateway"),
				2000,
			);
			assert.ok(waited >= 400, `wrote after ${waited} ms, before the 500 ms debounce`);
		} finally {
			disconnect(client);
			await server.close();
		}
	});

	it("writes once, 500 ms after the last of several quick edits", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const writes: number[] = [];
		const { server } = await start({ root, onSnapshotWrite: () => writes.push(Date.now()) });
		const client = await connect(server, "main");
		try {
			let lastEdit = 0;
			for (let i = 0; i < 5; i++) {
				setField(client.doc, "ui", "b_api", "title", `title ${i}`);
				lastEdit = Date.now();
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			await waitFor(() => writes.length > 0, 2000);
			await new Promise((resolve) => setTimeout(resolve, 700));
			assert.equal(writes.length, 1);
			assert.ok((writes[0] as number) - lastEdit >= 450, `${(writes[0] as number) - lastEdit} ms`);
			assert.ok(fileText(root, "main").includes("title 4"));
		} finally {
			disconnect(client);
			await server.close();
		}
	});

	it("creates the snapshot file for a new flow after its first edit", async () => {
		const root = tempRoot();
		const { server } = await start({ root, debounceMs: 20 });
		const client = await connect(server, "fresh");
		try {
			addBlock(client.doc, "ui", { id: "b_one", level: "architecture", title: "One" });
			await waitFor(() => existsSync(join(root, ".flowplan", "fresh.json")));
			const saved = parseSnapshot(fileText(root, "fresh"));
			assert.ok(saved.ok);
			assert.deepEqual(
				saved.snapshot.blocks.map((b) => b.id),
				["b_one"],
			);
		} finally {
			disconnect(client);
			await server.close();
		}
	});

	it("never lets a reader see a partly written snapshot file", async () => {
		const root = tempRoot();
		const big = sampleSnapshot();
		for (const block of big.blocks) block.pseudocode = "x".repeat(90_000);
		await writeFlow(root, "main", big);
		let writes = 0;
		const { server } = await start({ root, debounceMs: 1, onSnapshotWrite: () => writes++ });
		const client = await connect(server, "main");
		let reads = 0;
		let reading = true;
		const reader = (async () => {
			while (reading) {
				const result = parseSnapshot(fileText(root, "main"));
				assert.ok(result.ok, "a read saw a file that is not a whole snapshot");
				reads++;
				await new Promise((resolve) => setImmediate(resolve));
			}
		})();
		try {
			for (let i = 0; i < 40; i++) {
				setField(client.doc, "ui", "b_store", "title", `store ${i}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			await waitFor(() => fileText(root, "main").includes("store 39"));
		} finally {
			reading = false;
			await reader;
			disconnect(client);
			await server.close();
		}
		assert.ok(writes >= 10, `only ${writes} writes`);
		assert.ok(reads >= 10, `only ${reads} reads`);
		assert.deepEqual(readdirSync(join(root, ".flowplan")).sort(), [".gitignore", "main.json"]);
	});
});

describe("snapshot validation before each write", () => {
	it("keeps the last valid file and logs the error when the live document gives a snapshot that is not valid", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server, logged } = await start({ root, debounceMs: 20 });
		const client = await connect(server, "main");
		try {
			setField(client.doc, "ui", "b_api", "title", "valid change");
			await waitFor(() => fileText(root, "main").includes("valid change"));
			const lastValid = fileText(root, "main");

			client.doc.transact(() => {
				(client.doc.getMap("blocks").get("b_store") as Y.Map<unknown>).set("level", "bogus");
			});
			await waitFor(() => logged.some((line) => line.includes("not valid")));
			assert.ok(
				logged.some((line) => line.includes("main") && line.includes("level")),
				logged.join("\n"),
			);
			assert.equal(fileText(root, "main"), lastValid);

			client.doc.transact(() => {
				(client.doc.getMap("blocks").get("b_store") as Y.Map<unknown>).set("level", "service");
			});
			setField(client.doc, "ui", "b_api", "title", "valid again");
			await waitFor(() => fileText(root, "main").includes("valid again"));
		} finally {
			disconnect(client);
			await server.close();
		}
	});

	it("keeps running and keeps the last valid file when a client writes a block that is not a map", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server, logged } = await start({ root, debounceMs: 20 });
		const client = await connect(server, "main");
		const lastValid = fileText(root, "main");
		try {
			client.doc.getMap("blocks").set("b_junk", "not a block");
			await waitFor(() => logged.length > 0);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(fileText(root, "main"), lastValid);
			client.doc.getMap("blocks").delete("b_junk");
			setField(client.doc, "ui", "b_api", "title", "recovered");
			await waitFor(() => fileText(root, "main").includes("recovered"));
		} finally {
			disconnect(client);
			await server.close();
		}
	});

	it("keeps running and keeps the flow unchanged when a client sends frames that are not valid", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server, logged } = await start({ root });
		try {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}/main?token=${server.token}`);
			await new Promise((resolve) => socket.on("open", resolve));
			const closed = new Promise<number>((resolve) => socket.on("close", resolve));
			socket.send(Buffer.from([0, 2, 5, 1, 2, 3, 4, 5]));
			socket.send(Buffer.from([0, 9]));
			assert.equal(await closed, 1003);
			assert.ok(
				logged.some((line) => line.includes("not valid")),
				logged.join("\n"),
			);
			const client = await connect(server, "main");
			assert.deepEqual(docToSnapshot(client.doc), sampleSnapshot());
			disconnect(client);
		} finally {
			await server.close();
		}
	});
});

describe("server.json", () => {
	it("holds the port, the process ID and the token, readable only by the owner, and is removed at stop", async () => {
		const root = tempRoot();
		const { server } = await start({ root });
		const path = join(root, ".flowplan", "server.json");
		try {
			const info = JSON.parse(readFileSync(path, "utf8"));
			assert.deepEqual(info, { pid: process.pid, port: server.port, token: server.token });
			assert.match(server.token, /^[A-Za-z0-9_-]{43}$/);
			assert.equal(statSync(path).mode & 0o777, 0o600);
		} finally {
			await server.close();
		}
		assert.equal(existsSync(path), false);
	});

	it("refuses to start when server.json names a process that is running", async () => {
		const root = tempRoot();
		const { server } = await start({ root });
		try {
			await assert.rejects(startServer({ root, log: () => {} }), /already running.*pid/);
		} finally {
			await server.close();
		}
	});

	it("starts and replaces server.json when it names a process that is not running", async () => {
		const root = tempRoot();
		await writeFlow(root, "server", JSON.stringify({ pid: 2 ** 22 + 12345, port: 1, token: "old" }));
		const { server } = await start({ root });
		try {
			const info = JSON.parse(readFileSync(join(root, ".flowplan", "server.json"), "utf8"));
			assert.equal(info.pid, process.pid);
		} finally {
			await server.close();
		}
	});
});

describe(".flowplan/.gitignore in the planned repo", () => {
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

	it("makes git ignore server.json and temporary files, and not a flow snapshot, in a repo with no .flowplan/.gitignore", async () => {
		const root = tempRoot();
		git(root, "init", "-q");
		await writeFlow(root, "main", sampleSnapshot());
		const { server } = await start({ root });
		try {
			const ignored = git(
				root,
				"check-ignore",
				".flowplan/server.json",
				".flowplan/.main.json.123.4.tmp",
				".flowplan/server.json.123.tmp",
			);
			assert.deepEqual(ignored.trim().split("\n"), [
				".flowplan/server.json",
				".flowplan/.main.json.123.4.tmp",
				".flowplan/server.json.123.tmp",
			]);
			assert.throws(() => git(root, "check-ignore", ".flowplan/main.json"));
			assert.throws(() => git(root, "check-ignore", ".flowplan/.gitignore"));
		} finally {
			await server.close();
		}
	});

	it("refuses to start when .flowplan/.gitignore is a symlink, and leaves its target unchanged", async () => {
		const root = tempRoot();
		const outside = join(tempRoot(), "target.txt");
		writeFileSync(outside, "keep me\n");
		await mkdir(join(root, ".flowplan"), { recursive: true });
		symlinkSync(outside, join(root, ".flowplan", ".gitignore"));
		await assert.rejects(startServer({ root, log: () => {} }), /\.gitignore.*not a regular file/);
		assert.equal(readFileSync(outside, "utf8"), "keep me\n");
		assert.equal(existsSync(join(root, ".flowplan", "server.json")), false);
	});

	it("adds only the missing lines and keeps every other line", async () => {
		const root = tempRoot();
		await mkdir(join(root, ".flowplan"), { recursive: true });
		writeFileSync(join(root, ".flowplan", ".gitignore"), "# mine\nscratch/\nserver.json");
		const { server } = await start({ root });
		try {
			assert.equal(
				readFileSync(join(root, ".flowplan", ".gitignore"), "utf8"),
				"# mine\nscratch/\nserver.json\n*.tmp\n",
			);
		} finally {
			await server.close();
		}
		const again = await start({ root });
		await again.server.close();
		assert.equal(readFileSync(join(root, ".flowplan", ".gitignore"), "utf8"), "# mine\nscratch/\nserver.json\n*.tmp\n");
	});
});
