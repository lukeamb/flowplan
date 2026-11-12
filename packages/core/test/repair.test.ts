import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import {
	addBlock,
	addConnection,
	docToSnapshot,
	planRepair,
	repairFlow,
	type Snapshot,
	setField,
	snapshotToDoc,
	validateSnapshot,
} from "../src/index.ts";

function sync(a: Y.Doc, b: Y.Doc): void {
	const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
	const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
	Y.applyUpdate(b, toB, "remote");
	Y.applyUpdate(a, toA, "remote");
}

function flow(): Snapshot {
	const block = (id: string, level: "architecture" | "service" | "function", parentId: string | null) => ({
		id,
		level,
		parentId,
		title: id,
		pseudocode: "",
		position: { x: 0, y: 0 },
	});
	return {
		schemaVersion: 1,
		blocks: [
			block("a", "architecture", null),
			block("kid", "function", "y"),
			block("w", "service", "a"),
			block("x", "service", "a"),
			block("y", "service", "a"),
		],
		connections: [{ id: "c_kid_w", from: "kid", to: "w", label: "" }],
	};
}

function pair(): [Y.Doc, Y.Doc] {
	const a = snapshotToDoc(flow());
	const b = new Y.Doc();
	sync(a, b);
	return [a, b];
}

const parents = (snapshot: Snapshot) => Object.fromEntries(snapshot.blocks.map((b) => [b.id, b.parentId]));

function assertValid(snapshot: Snapshot): void {
	const result = validateSnapshot(snapshot);
	assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.errors));
}

describe("concurrent parentId changes that form a cycle", () => {
	it("keep every block in the cycle and every child, and give a valid snapshot", () => {
		const [a, b] = pair();
		setField(a, "ui", "x", "parentId", "y");
		setField(b, "agent", "y", "parentId", "x");
		sync(a, b);
		for (const doc of [a, b]) {
			const snapshot = docToSnapshot(doc);
			assertValid(snapshot);
			assert.deepEqual(parents(snapshot), { a: null, kid: "y", w: "a", x: null, y: "x" });
			assert.deepEqual(
				snapshot.connections.map((c) => c.id),
				["c_kid_w"],
			);
		}
	});

	it("are repaired in the live document by moving the lowest ID in the cycle to the top canvas, with no delete", () => {
		const [a, b] = pair();
		setField(a, "ui", "x", "parentId", "y");
		setField(b, "agent", "y", "parentId", "x");
		sync(a, b);
		const expected = docToSnapshot(a);
		assert.deepEqual(repairFlow(a), { removed: [], moved: ["x"] });
		assert.deepEqual(docToSnapshot(a), expected);
		assert.equal(a.getMap("blocks").size, 5);
		sync(a, b);
		assert.deepEqual(docToSnapshot(b), expected);
		assert.deepEqual(repairFlow(b), { removed: [], moved: [] });
	});

	it("break a cycle of three blocks at its lowest ID", () => {
		const [a, b] = pair();
		const c = new Y.Doc();
		sync(a, c);
		setField(a, "ui", "w", "parentId", "x");
		setField(b, "agent", "x", "parentId", "y");
		setField(c, "agent", "y", "parentId", "w");
		sync(a, b);
		sync(a, c);
		sync(b, c);
		const snapshot = docToSnapshot(a);
		assertValid(snapshot);
		assert.deepEqual(parents(snapshot), { a: null, kid: "y", w: null, x: "y", y: "w" });
	});

	it("converge to the same document when two replicas repair at the same time, with no further edits", () => {
		const [a, b] = pair();
		setField(a, "ui", "x", "parentId", "y");
		setField(b, "agent", "y", "parentId", "x");
		sync(a, b);
		repairFlow(a);
		repairFlow(b);
		sync(a, b);
		assert.deepEqual(docToSnapshot(a), docToSnapshot(b));
		assertValid(docToSnapshot(a));
		assert.deepEqual(repairFlow(a), { removed: [], moved: [] });
		assert.deepEqual(repairFlow(b), { removed: [], moved: [] });
	});
});

describe("a block whose parent became a function block through concurrent changes", () => {
	it("moves to the nearest ancestor that is not a function block, and is not deleted", () => {
		const [a, b] = pair();
		setField(a, "ui", "x", "level", "function");
		addBlock(b, "agent", { id: "x_child", level: "function", parentId: "x", title: "child" });
		addConnection(b, "agent", { id: "c_child_w", from: "x_child", to: "w" });
		sync(a, b);
		const snapshot = docToSnapshot(a);
		assertValid(snapshot);
		assert.equal(parents(snapshot).x_child, "a");
		assert.ok(snapshot.connections.some((c) => c.id === "c_child_w"));
		assert.deepEqual(repairFlow(a), { removed: [], moved: ["x_child"] });
		sync(a, b);
		assert.deepEqual(docToSnapshot(b), snapshot);
	});

	it("moves past several function ancestors to the top canvas when none is left", () => {
		const plan = planRepair(
			new Map([
				["f1", { level: "function", parentId: null }],
				["f2", { level: "function", parentId: "f1" }],
				["s", { level: "service", parentId: "f2" }],
			]),
		);
		assert.deepEqual(plan, {
			remove: [],
			move: new Map([
				["f2", null],
				["s", null],
			]),
		});
	});
});

describe("planRepair", () => {
	it("removes only a block whose parent no longer exists, with its subtree", () => {
		const plan = planRepair(
			new Map([
				["a", { level: "architecture", parentId: null }],
				["lost", { level: "service", parentId: "gone" }],
				["lost_kid", { level: "function", parentId: "lost" }],
				["ok", { level: "service", parentId: "a" }],
			]),
		);
		assert.deepEqual(plan, { remove: ["lost", "lost_kid"], move: new Map() });
	});

	it("plans nothing for a valid flow", () => {
		const blocks = new Map(flow().blocks.map((b) => [b.id, { level: b.level, parentId: b.parentId }]));
		assert.deepEqual(planRepair(blocks), { remove: [], move: new Map() });
	});

	it("gives the same plan for the same blocks in any insertion order", () => {
		const entries: [string, { level: string; parentId: string | null }][] = [
			["p", { level: "service", parentId: "q" }],
			["q", { level: "service", parentId: "r" }],
			["r", { level: "service", parentId: "p" }],
			["s", { level: "service", parentId: "t" }],
			["t", { level: "service", parentId: "s" }],
		];
		const forward = planRepair(new Map(entries));
		const backward = planRepair(new Map([...entries].reverse()));
		assert.deepEqual(forward, backward);
		assert.deepEqual(
			forward.move,
			new Map([
				["p", null],
				["s", null],
			]),
		);
	});
});
