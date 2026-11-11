import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import { docToSnapshot, parseSnapshot, type Snapshot, serializeSnapshot, snapshotToDoc } from "../src/index.ts";
import { sampleSnapshot } from "./fixtures.ts";

function roundTrip(snapshot: Snapshot): Snapshot {
	return docToSnapshot(snapshotToDoc(snapshot));
}

describe("snapshot to Yjs and back", () => {
	it("gives a snapshot equal to the original", () => {
		const original = sampleSnapshot();
		assert.deepEqual(roundTrip(original), original);
	});

	it("gives a snapshot equal to the original after a Yjs update is applied to a new document", () => {
		const original = sampleSnapshot();
		const copy = new Y.Doc();
		Y.applyUpdate(copy, Y.encodeStateAsUpdate(snapshotToDoc(original)));
		assert.deepEqual(docToSnapshot(copy), original);
	});

	it("keeps every block and connection ID across saves and loads", () => {
		const original = sampleSnapshot();
		const once = parseSnapshot(serializeSnapshot(roundTrip(original)));
		assert.ok(once.ok);
		const twice = roundTrip(once.snapshot);
		assert.deepEqual(
			twice.blocks.map((b) => b.id),
			original.blocks.map((b) => b.id),
		);
		assert.deepEqual(
			twice.connections.map((c) => c.id),
			original.connections.map((c) => c.id),
		);
	});

	it("keeps unknown fields under meta unchanged", () => {
		const original = sampleSnapshot();
		const login = original.blocks.find((b) => b.id === "b_login");
		assert.ok(login);
		login.meta = {
			reviewTick: { by: "luke", at: "2026-11-11" },
			nested: { list: [1, "two", { three: [null, false] }], empty: {} },
			"odd key": 1.5,
		};
		const result = roundTrip(original).blocks.find((b) => b.id === "b_login");
		assert.deepEqual(result?.meta, login.meta);
	});

	it("keeps an absent meta and an absent source absent", () => {
		const result = roundTrip(sampleSnapshot()).blocks.find((b) => b.id === "b_root");
		assert.ok(result);
		assert.equal("meta" in result, false);
		assert.equal("source" in result, false);
	});

	it("sorts blocks and connections by ID", () => {
		const original = sampleSnapshot();
		original.blocks.reverse();
		const result = roundTrip(original);
		assert.deepEqual(
			result.blocks.map((b) => b.id),
			["b_api", "b_login", "b_root", "b_store"],
		);
	});
});

describe("serializeSnapshot", () => {
	it("gives byte-identical files for two conversions of the same document", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.equal(serializeSnapshot(docToSnapshot(doc)), serializeSnapshot(docToSnapshot(doc)));
	});

	it("gives byte-identical files for the same flow built in a different order", () => {
		const forward = sampleSnapshot();
		const backward = sampleSnapshot();
		backward.blocks.reverse();
		const login = backward.blocks.find((b) => b.id === "b_login");
		assert.ok(login?.meta);
		login.meta = Object.fromEntries(Object.entries(login.meta).reverse());
		const a = serializeSnapshot(docToSnapshot(snapshotToDoc(forward)));
		const b = serializeSnapshot(docToSnapshot(snapshotToDoc(backward)));
		assert.equal(a, b);
	});

	it("writes object keys in sorted order at every depth", () => {
		const text = serializeSnapshot(sampleSnapshot());
		const keyOrders: string[][] = [];
		JSON.parse(text, (_key, value) => {
			if (value && typeof value === "object" && !Array.isArray(value)) keyOrders.push(Object.keys(value));
			return value;
		});
		for (const keys of keyOrders) assert.deepEqual(keys, [...keys].sort());
	});

	it("ends the file with one newline and indents with two spaces", () => {
		const text = serializeSnapshot(sampleSnapshot());
		assert.ok(text.endsWith("}\n"));
		assert.ok(text.includes('\n  "blocks": ['));
	});
});

describe("parseSnapshot", () => {
	it("reads a serialized snapshot", () => {
		const result = parseSnapshot(serializeSnapshot(sampleSnapshot()));
		assert.equal(result.ok, true);
	});

	it("reports text that is not JSON at the root path", () => {
		const result = parseSnapshot("{ not json");
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.errors[0]?.path, "$");
	});

	it("reports schema errors with their JSON paths", () => {
		const result = parseSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [{}], connections: [] }));
		assert.equal(result.ok, false);
		assert.ok(!result.ok && result.errors.some((e) => e.path === "$.blocks[0].id"));
	});
});

describe("snapshotToDoc", () => {
	it("refuses a snapshot that is not valid", () => {
		const snapshot = sampleSnapshot();
		const block = snapshot.blocks[0];
		assert.ok(block);
		block.parentId = "b_missing";
		assert.throws(() => snapshotToDoc(snapshot), /parentId/);
	});
});
