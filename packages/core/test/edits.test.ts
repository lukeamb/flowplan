import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import {
	addBlock,
	addConnection,
	createId,
	deleteItem,
	docToSnapshot,
	edit,
	FlowEditError,
	type Origin,
	originOf,
	pruneOrphans,
	setField,
	snapshotToDoc,
	textField,
} from "../src/index.ts";
import { sampleSnapshot } from "./fixtures.ts";

function sync(a: Y.Doc, b: Y.Doc): void {
	const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
	const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
	Y.applyUpdate(b, toB, "remote");
	Y.applyUpdate(a, toA, "remote");
}

function pair(): [Y.Doc, Y.Doc] {
	const a = snapshotToDoc(sampleSnapshot());
	const b = new Y.Doc();
	sync(a, b);
	return [a, b];
}

function ids(doc: Y.Doc) {
	const snapshot = docToSnapshot(doc);
	return {
		blocks: snapshot.blocks.map((x) => x.id),
		connections: snapshot.connections.map((x) => x.id),
	};
}

describe("concurrent text edits", () => {
	it("keeps both insertions into the same block's pseudocode after sync", () => {
		const [a, b] = pair();
		edit(a, "ui", () => textField(a, "b_api", "pseudocode").insert(0, "UI: "));
		edit(b, "agent", () => {
			const text = textField(b, "b_api", "pseudocode");
			text.insert(text.length, "\nAGENT: log it");
		});
		sync(a, b);
		const expected = "UI: receive request\nvalidate token\nAGENT: log it";
		assert.equal(textField(a, "b_api", "pseudocode").toString(), expected);
		assert.equal(textField(b, "b_api", "pseudocode").toString(), expected);
	});

	it("keeps both insertions at the same index after sync", () => {
		const [a, b] = pair();
		edit(a, "ui", () => textField(a, "b_store", "pseudocode").insert(0, "AAA"));
		edit(b, "agent", () => textField(b, "b_store", "pseudocode").insert(0, "BBB"));
		sync(a, b);
		const merged = textField(a, "b_store", "pseudocode").toString();
		assert.equal(merged, textField(b, "b_store", "pseudocode").toString());
		assert.ok(merged.includes("AAA") && merged.includes("BBB") && merged.endsWith("SELECT user"), merged);
	});

	it("setField on a text field edits the shared Y.Text, so a concurrent insertion survives", () => {
		const [a, b] = pair();
		const before = textField(a, "b_api", "title");
		setField(a, "agent", "b_api", "title", "API gateway");
		assert.equal(textField(a, "b_api", "title"), before);
		edit(b, "ui", () => textField(b, "b_api", "title").insert(0, "v2 "));
		sync(a, b);
		assert.equal(textField(a, "b_api", "title").toString(), textField(b, "b_api", "title").toString());
		assert.ok(textField(a, "b_api", "title").toString().includes("v2 "));
	});
});

describe("deleteItem", () => {
	it("removes every connection to and from the deleted block", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		addConnection(doc, "ui", { id: "c_store_api", from: "b_store", to: "b_api", label: "row" });
		addConnection(doc, "ui", { id: "c_root_store", from: "b_root", to: "b_store", label: "" });
		const removed = deleteItem(doc, "agent", "b_store");
		assert.deepEqual(removed.sort(), ["b_store", "c_api_store", "c_root_store", "c_store_api"]);
		assert.deepEqual(ids(doc).connections, []);
		assert.equal(doc.getMap("connections").size, 0);
	});

	it("removes every block in the child canvas, at every depth, and their connections", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		addBlock(doc, "ui", { id: "b_other", level: "architecture", title: "Billing" });
		addConnection(doc, "ui", { id: "c_login_other", from: "b_login", to: "b_other", label: "event" });
		const removed = deleteItem(doc, "ui", "b_root");
		assert.deepEqual(removed.sort(), ["b_api", "b_login", "b_root", "b_store", "c_api_store", "c_login_other"]);
		assert.deepEqual(ids(doc), { blocks: ["b_other"], connections: [] });
		assert.deepEqual([...doc.getMap("blocks").keys()], ["b_other"]);
	});

	it("removes a connection and leaves its blocks", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.deepEqual(deleteItem(doc, "ui", "c_api_store"), ["c_api_store"]);
		assert.equal(ids(doc).blocks.length, 4);
	});

	it("deletes in one transaction", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		let transactions = 0;
		doc.on("afterTransaction", () => transactions++);
		deleteItem(doc, "ui", "b_root");
		assert.equal(transactions, 1);
	});

	it("refuses an ID that does not exist", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => deleteItem(doc, "ui", "b_missing"), FlowEditError);
	});

	it("wins over a concurrent edit of the deleted block", () => {
		const [a, b] = pair();
		deleteItem(a, "agent", "b_api");
		edit(b, "ui", () => textField(b, "b_api", "pseudocode").insert(0, "late edit "));
		setField(b, "ui", "b_api", "position", { x: 1, y: 2 });
		sync(a, b);
		for (const doc of [a, b]) {
			assert.deepEqual(ids(doc), { blocks: ["b_root", "b_store"], connections: [] });
		}
	});

	it("leaves no orphan when another user adds a child or a connection to a block that is deleted at the same time", () => {
		const [a, b] = pair();
		deleteItem(a, "agent", "b_api");
		addBlock(b, "ui", { id: "b_new", level: "function", parentId: "b_api", title: "new()" });
		addConnection(b, "ui", { id: "c_new", from: "b_store", to: "b_api", label: "" });
		sync(a, b);
		assert.deepEqual(ids(a), { blocks: ["b_root", "b_store"], connections: [] });
		const removed = pruneOrphans(a, "ui");
		assert.deepEqual(removed.sort(), ["b_new", "c_new"]);
		sync(a, b);
		assert.deepEqual([...b.getMap("blocks").keys()].sort(), ["b_root", "b_store"]);
		assert.equal(b.getMap("connections").size, 0);
	});
});

describe("edit origin", () => {
	function originsSeenBy(doc: Y.Doc): (Origin | undefined)[] {
		const seen: (Origin | undefined)[] = [];
		doc.on("afterTransaction", (tx: Y.Transaction) => seen.push(originOf(tx)));
		return seen;
	}

	it("reports the origin of a local edit", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		const seen = originsSeenBy(doc);
		setField(doc, "agent", "b_api", "title", "x");
		setField(doc, "ui", "b_api", "title", "y");
		assert.deepEqual(seen, ["agent", "ui"]);
	});

	it("carries the origin to another document through a Yjs update", () => {
		const [a, b] = pair();
		const seen = originsSeenBy(b);
		for (const origin of ["agent", "ui", "agent"] as const) {
			setField(a, origin, "b_api", "title", origin);
			sync(a, b);
		}
		assert.deepEqual(seen, ["agent", "ui", "agent"]);
	});

	it("carries the origin of a delete to another document", () => {
		const [a, b] = pair();
		const seen = originsSeenBy(b);
		deleteItem(a, "agent", "c_api_store");
		sync(a, b);
		assert.deepEqual(seen, ["agent"]);
	});

	it("reports no origin for a change made outside edit()", () => {
		const doc = new Y.Doc();
		const seen = originsSeenBy(doc);
		snapshotToDoc(sampleSnapshot(), doc);
		assert.deepEqual(seen, [undefined]);
	});

	it("refuses an origin that is not ui or agent", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => edit(doc, "server" as Origin, () => {}), FlowEditError);
	});
});

describe("addBlock", () => {
	it("adds a block and returns its new ID", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		const id = addBlock(doc, "agent", {
			level: "service",
			parentId: "b_root",
			title: "Mailer",
			position: { x: 5, y: 6 },
		});
		const block = docToSnapshot(doc).blocks.find((b) => b.id === id);
		assert.deepEqual(block, {
			id,
			level: "service",
			parentId: "b_root",
			title: "Mailer",
			pseudocode: "",
			position: { x: 5, y: 6 },
		});
	});

	it("refuses a function block as the parent", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => addBlock(doc, "ui", { level: "function", parentId: "b_login", title: "x" }), /function/);
	});

	it("refuses an ID that is already used by a block or a connection", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => addBlock(doc, "ui", { id: "c_api_store", level: "service", title: "x" }), FlowEditError);
	});

	it("refuses a source that is not path:line", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => addBlock(doc, "ui", { level: "service", title: "x", source: "nope" }), /source/);
	});
});

describe("addConnection", () => {
	it("refuses an end that names no block", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => addConnection(doc, "ui", { from: "b_api", to: "b_missing", label: "" }), FlowEditError);
	});
});

describe("setField", () => {
	it("sets one field of a block and leaves the others", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		setField(doc, "agent", "b_store", "source", "db/users.sql:4");
		const expected = sampleSnapshot();
		const store = expected.blocks.find((b) => b.id === "b_store");
		assert.ok(store);
		store.source = "db/users.sql:4";
		assert.deepEqual(docToSnapshot(doc), expected);
	});

	it("removes the source when the value is null", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		setField(doc, "agent", "b_api", "source", null);
		assert.equal(docToSnapshot(doc).blocks.find((b) => b.id === "b_api")?.source, undefined);
	});

	it("sets the label of a connection", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		setField(doc, "agent", "c_api_store", "label", "user row");
		assert.equal(docToSnapshot(doc).connections[0]?.label, "user row");
	});

	it("refuses to make a block with children a function block", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => setField(doc, "ui", "b_api", "level", "function"), /function/);
	});

	it("refuses a parentId that makes a cycle", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => setField(doc, "ui", "b_root", "parentId", "b_api"), /cycle/);
	});

	it("refuses a field that the item does not have", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => setField(doc, "ui", "c_api_store", "level", "service"), FlowEditError);
		assert.throws(() => setField(doc, "ui", "b_api", "colour", "red"), FlowEditError);
	});

	it("refuses a value of the wrong type", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.throws(() => setField(doc, "ui", "b_api", "position", { x: "1", y: 2 }), FlowEditError);
		assert.throws(() => setField(doc, "ui", "b_api", "title", 5), FlowEditError);
	});

	it("leaves the document a valid snapshot after each edit", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		setField(doc, "ui", "b_store", "parentId", null);
		setField(doc, "ui", "b_login", "parentId", "b_store");
		const snapshot = docToSnapshot(doc);
		assert.equal(snapshot.blocks.length, 4);
	});
});

describe("createId", () => {
	it("makes distinct IDs that match the ID pattern", () => {
		const made = new Set(Array.from({ length: 1000 }, () => createId("b")));
		assert.equal(made.size, 1000);
		for (const id of made) assert.match(id, /^b_[A-Za-z0-9_-]{1,61}$/);
	});
});
