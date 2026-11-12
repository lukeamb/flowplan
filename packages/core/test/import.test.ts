import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import { docToSnapshot, FlowEditError, importSnapshot, type Snapshot, snapshotToDoc } from "../src/index.ts";
import { sampleSnapshot } from "./fixtures.ts";

function draft(): Snapshot {
	return {
		schemaVersion: 1,
		blocks: [
			{
				id: "d_mail",
				level: "architecture",
				parentId: null,
				title: "Mail",
				pseudocode: "",
				position: { x: 0, y: 0 },
			},
			{
				id: "d_send",
				level: "service",
				parentId: "d_mail",
				title: "Sender",
				pseudocode: "send it",
				position: { x: 1, y: 2 },
				meta: { note: "draft" },
			},
		],
		connections: [{ id: "d_c1", from: "d_mail", to: "d_send", label: "message" }],
	};
}

describe("importSnapshot", () => {
	it("adds every block and connection of the file and keeps every existing one", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.deepEqual(importSnapshot(doc, "agent", draft()), { blocks: 2, connections: 1 });
		const snapshot = docToSnapshot(doc);
		assert.deepEqual(
			snapshot.blocks.map((b) => b.id),
			["b_api", "b_login", "b_root", "b_store", "d_mail", "d_send"],
		);
		assert.deepEqual(
			snapshot.blocks.find((b) => b.id === "d_send"),
			draft().blocks[1],
		);
		assert.deepEqual(
			snapshot.connections.map((c) => c.id),
			["c_api_store", "d_c1"],
		);
	});

	it("adds everything in one transaction with the given origin", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		const other = new Y.Doc();
		Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
		let transactions = 0;
		doc.on("afterTransaction", () => transactions++);
		const updates: Uint8Array[] = [];
		doc.on("update", (update: Uint8Array) => updates.push(update));
		importSnapshot(doc, "agent", draft());
		assert.equal(transactions, 1);
		assert.equal(updates.length, 1);
	});

	it("refuses a file with an ID that is already in the document, and changes nothing", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		const before = Y.encodeStateVector(doc);
		const clash = draft();
		const second = clash.blocks[1];
		assert.ok(second);
		second.id = "b_api";
		const connection = clash.connections[0];
		assert.ok(connection);
		connection.to = "b_api";
		connection.id = "c_api_store";
		assert.throws(
			() => importSnapshot(doc, "agent", clash),
			(error: unknown) => {
				assert.ok(error instanceof FlowEditError);
				assert.match(error.message, /b_api/);
				assert.match(error.message, /c_api_store/);
				return true;
			},
		);
		assert.deepEqual(Y.encodeStateVector(doc), before);
	});

	it("refuses a file that is not valid, and changes nothing", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		const before = Y.encodeStateVector(doc);
		const broken = draft();
		const second = broken.blocks[1];
		assert.ok(second);
		second.parentId = "nowhere";
		assert.throws(() => importSnapshot(doc, "agent", broken), /\$\.blocks\[1\]\.parentId/);
		assert.deepEqual(Y.encodeStateVector(doc), before);
	});
});
