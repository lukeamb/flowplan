import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildJsonSchema, SCHEMA_VERSION, validateSnapshot } from "../src/index.ts";
import { sampleSnapshot } from "./fixtures.ts";

const schemaFile = new URL("../schema/flow-snapshot.schema.json", import.meta.url);

function errorsOf(value: unknown) {
	const result = validateSnapshot(value);
	assert.equal(result.ok, false);
	return result.ok ? [] : result.errors;
}

describe("flow snapshot JSON schema file", () => {
	it("matches the schema that the validator uses", () => {
		const committed = JSON.parse(readFileSync(schemaFile, "utf8"));
		assert.deepEqual(committed, buildJsonSchema());
	});

	it("documents the snapshot and every block and connection field", () => {
		const schema = buildJsonSchema() as {
			description?: string;
			$defs: Record<string, { description?: string; properties: Record<string, { description?: string }> }>;
		};
		assert.ok(schema.description);
		for (const name of ["block", "connection"]) {
			const def = schema.$defs[name];
			assert.ok(def?.description, `${name} has a description`);
			for (const [field, prop] of Object.entries(def.properties)) {
				assert.ok(prop.description, `${name}.${field} has a description`);
			}
		}
	});
});

describe("validateSnapshot", () => {
	it("accepts a valid snapshot", () => {
		const result = validateSnapshot(sampleSnapshot());
		assert.equal(result.ok, true);
	});

	it("requires schemaVersion", () => {
		const { schemaVersion: _, ...rest } = sampleSnapshot();
		assert.deepEqual(
			errorsOf(rest).map((e) => e.path),
			["$.schemaVersion"],
		);
	});

	it("refuses an unknown schemaVersion", () => {
		const errors = errorsOf({ ...sampleSnapshot(), schemaVersion: SCHEMA_VERSION + 1 });
		assert.deepEqual(
			errors.map((e) => e.path),
			["$.schemaVersion"],
		);
	});

	it("requires an id on each block and each connection", () => {
		const snapshot = sampleSnapshot() as unknown as {
			blocks: Record<string, unknown>[];
			connections: Record<string, unknown>[];
		};
		delete snapshot.blocks[0]?.id;
		delete snapshot.connections[0]?.id;
		assert.deepEqual(
			errorsOf(snapshot).map((e) => e.path),
			["$.blocks[0].id", "$.connections[0].id"],
		);
	});

	it("refuses an id that is used twice", () => {
		const snapshot = sampleSnapshot();
		const connection = snapshot.connections[0];
		assert.ok(connection);
		connection.id = "b_api";
		assert.deepEqual(
			errorsOf(snapshot).map((e) => e.path),
			["$.connections[0].id"],
		);
	});

	it("accepts each of the three levels", () => {
		for (const level of ["architecture", "service", "function"] as const) {
			const snapshot = sampleSnapshot();
			const store = snapshot.blocks[3];
			assert.ok(store);
			store.level = level;
			assert.equal(validateSnapshot(snapshot).ok, true, level);
		}
	});

	it("refuses a level outside architecture, service and function", () => {
		const snapshot = sampleSnapshot() as unknown as { blocks: { level: string }[] };
		const block = snapshot.blocks[0];
		assert.ok(block);
		block.level = "module";
		assert.deepEqual(
			errorsOf(snapshot).map((e) => e.path),
			["$.blocks[0].level"],
		);
	});

	it("accepts a block with no source", () => {
		const snapshot = sampleSnapshot();
		assert.equal(snapshot.blocks[1]?.source, undefined);
		assert.equal(validateSnapshot(snapshot).ok, true);
	});

	it("accepts a source in the form path:line", () => {
		for (const source of ["a.ts:1", "src/deep dir/x.go:1200", "C:/repo/a.ts:9"]) {
			const snapshot = sampleSnapshot();
			const block = snapshot.blocks[0];
			assert.ok(block);
			block.source = source;
			assert.equal(validateSnapshot(snapshot).ok, true, source);
		}
	});

	it("refuses a source that is not path:line", () => {
		for (const source of ["a.ts", "a.ts:", ":12", "a.ts:0", "a.ts:x", "a.ts:1\nb"]) {
			const snapshot = sampleSnapshot();
			const block = snapshot.blocks[0];
			assert.ok(block);
			block.source = source;
			assert.deepEqual(
				errorsOf(snapshot).map((e) => e.path),
				["$.blocks[0].source"],
				source,
			);
		}
	});

	it("refuses a function block that is the parent of another block", () => {
		const snapshot = sampleSnapshot();
		snapshot.blocks.push({
			id: "b_child",
			level: "function",
			parentId: "b_login",
			title: "hash()",
			pseudocode: "",
			position: { x: 0, y: 0 },
		});
		const errors = errorsOf(snapshot);
		assert.deepEqual(
			errors.map((e) => e.path),
			["$.blocks[4].parentId"],
		);
		assert.match(errors[0]?.message ?? "", /function/);
	});

	it("refuses a parentId that names no block", () => {
		const snapshot = sampleSnapshot();
		const block = snapshot.blocks[0];
		assert.ok(block);
		block.parentId = "b_missing";
		assert.deepEqual(
			errorsOf(snapshot).map((e) => e.path),
			["$.blocks[0].parentId"],
		);
	});

	it("refuses a parent cycle", () => {
		const snapshot = sampleSnapshot();
		const root = snapshot.blocks[2];
		assert.ok(root);
		root.parentId = "b_api";
		const paths = errorsOf(snapshot).map((e) => e.path);
		assert.ok(paths.includes("$.blocks[2].parentId"), paths.join());
	});

	it("refuses a connection to a block that does not exist", () => {
		const snapshot = sampleSnapshot();
		const connection = snapshot.connections[0];
		assert.ok(connection);
		connection.to = "b_missing";
		assert.deepEqual(
			errorsOf(snapshot).map((e) => e.path),
			["$.connections[0].to"],
		);
	});

	it("refuses an unknown field outside meta", () => {
		const snapshot = sampleSnapshot() as unknown as { blocks: Record<string, unknown>[] };
		const block = snapshot.blocks[0];
		assert.ok(block);
		block.colour = "red";
		assert.deepEqual(
			errorsOf(snapshot).map((e) => e.path),
			["$.blocks[0]"],
		);
	});

	it("reports the JSON path of every error", () => {
		const snapshot = sampleSnapshot() as unknown as { blocks: Record<string, unknown>[] };
		const first = snapshot.blocks[0];
		const second = snapshot.blocks[1];
		assert.ok(first && second);
		first.title = 7;
		second.position = { x: "a", y: 0 };
		assert.deepEqual(
			errorsOf(snapshot).map((e) => e.path),
			["$.blocks[0].title", "$.blocks[1].position.x"],
		);
	});
});
