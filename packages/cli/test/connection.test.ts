import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addBlock, docToSnapshot } from "@flowplan/core";
import type * as Y from "yjs";
import { sampleSnapshot } from "../../core/test/fixtures.ts";
import { openFlow } from "../src/index.ts";
import { startTestServer, tempRoot, writeFlow } from "./helpers.ts";

describe("openFlow close", () => {
	it("resolves only after the server has applied every edit made before it", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const server = await startTestServer(root);
		try {
			for (let i = 0; i < 20; i++) {
				const connection = await openFlow({ pid: process.pid, port: server.port, token: server.token }, "main");
				const id = addBlock(connection.doc, "agent", {
					id: `b_ack_${i}`,
					level: "architecture",
					pseudocode: "x".repeat(90_000),
				});
				await connection.close();
				const live = docToSnapshot(server.doc("main") as Y.Doc);
				assert.ok(
					live.blocks.some((b) => b.id === id),
					`edit ${i} not on the server when close() resolved`,
				);
			}
		} finally {
			await server.close();
		}
	});
});
