import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { docToSnapshot, MAX_MESSAGE_BYTES, type Snapshot, serializeSnapshot } from "@flowplan/core";
import type * as Y from "yjs";
import { sampleSnapshot } from "../../core/test/fixtures.ts";
import { runCli, startTestServer, tempRoot, writeFlow } from "./helpers.ts";

function hugeSnapshot(): Snapshot {
	const blocks = Array.from({ length: 180 }, (_, i) => ({
		id: `h_${String(i).padStart(3, "0")}`,
		level: "architecture" as const,
		parentId: null,
		title: `huge ${i}`,
		pseudocode: "x".repeat(95_000),
		position: { x: i, y: 0 },
	}));
	return { schemaVersion: 1, blocks, connections: [] };
}

describe("an edit over the server's message limit", () => {
	it("import refuses an update over the message limit before it sends anything, and exits 1 with the reason", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const file = join(root, "huge.json");
		writeFileSync(file, serializeSnapshot(hugeSnapshot()));
		const server = await startTestServer(root);
		try {
			const run = await runCli(["import", file, "--root", root], { timeoutMs: 60_000 });
			assert.equal(run.code, 1);
			assert.match(run.stderr, /over the server's message limit of 16 MiB/);
			assert.equal(run.stdout, "");
			assert.deepEqual(docToSnapshot(server.doc("main") as Y.Doc), sampleSnapshot());
		} finally {
			await server.close();
		}
	});

	it("set --stdin refuses a value whose update is over the message limit, and changes nothing", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const server = await startTestServer(root);
		try {
			const blob = JSON.stringify({ blob: "y".repeat(MAX_MESSAGE_BYTES) });
			const run = await runCli(["set", "--root", root, "--stdin", "b_api", "meta"], { stdin: blob, timeoutMs: 60_000 });
			assert.equal(run.code, 1);
			assert.match(run.stderr, /over the server's message limit/);
			assert.deepEqual(docToSnapshot(server.doc("main") as Y.Doc), sampleSnapshot());
		} finally {
			await server.close();
		}
	});
});
