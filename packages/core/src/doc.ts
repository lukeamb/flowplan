import * as Y from "yjs";
import { type Block, type Connection, SCHEMA_VERSION, type Snapshot, validateSnapshot } from "./schema.ts";
import { compareIds } from "./serialize.ts";

export const BLOCKS_KEY = "blocks";
export const CONNECTIONS_KEY = "connections";

export type BlockMap = Y.Map<unknown>;
export type ConnectionMap = Y.Map<unknown>;

export function blocksOf(doc: Y.Doc): Y.Map<BlockMap> {
	return doc.getMap<BlockMap>(BLOCKS_KEY);
}

export function connectionsOf(doc: Y.Doc): Y.Map<ConnectionMap> {
	return doc.getMap<ConnectionMap>(CONNECTIONS_KEY);
}

export function textOf(map: Y.Map<unknown>, key: string): string {
	const value = map.get(key);
	return value instanceof Y.Text ? value.toString() : "";
}

export function createBlockMap(block: Block): BlockMap {
	const map = new Y.Map<unknown>();
	map.set("level", block.level);
	map.set("parentId", block.parentId);
	map.set("title", new Y.Text(block.title));
	map.set("pseudocode", new Y.Text(block.pseudocode));
	map.set("position", { x: block.position.x, y: block.position.y });
	if (block.source !== undefined) map.set("source", block.source);
	if (block.meta !== undefined) map.set("meta", structuredClone(block.meta));
	return map;
}

export function createConnectionMap(connection: Connection): ConnectionMap {
	const map = new Y.Map<unknown>();
	map.set("from", connection.from);
	map.set("to", connection.to);
	map.set("label", new Y.Text(connection.label));
	return map;
}

export function addSnapshotContent(doc: Y.Doc, snapshot: Snapshot, origin?: unknown): void {
	doc.transact(() => {
		const blocks = blocksOf(doc);
		const connections = connectionsOf(doc);
		for (const block of snapshot.blocks) blocks.set(block.id, createBlockMap(block));
		for (const connection of snapshot.connections) connections.set(connection.id, createConnectionMap(connection));
	}, origin);
}

export function snapshotToDoc(snapshot: Snapshot, doc: Y.Doc = new Y.Doc()): Y.Doc {
	const result = validateSnapshot(snapshot);
	if (!result.ok) {
		throw new Error(`snapshot is not valid: ${result.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
	}
	addSnapshotContent(doc, result.snapshot);
	return doc;
}

function readBlock(id: string, map: BlockMap): Block {
	const position = map.get("position") as { x: number; y: number } | undefined;
	const block: Block = {
		id,
		level: map.get("level") as Block["level"],
		parentId: (map.get("parentId") as string | null | undefined) ?? null,
		title: textOf(map, "title"),
		pseudocode: textOf(map, "pseudocode"),
		position: { x: position?.x ?? 0, y: position?.y ?? 0 },
	};
	if (map.has("source")) block.source = map.get("source") as string;
	if (map.has("meta")) block.meta = structuredClone(map.get("meta")) as Block["meta"];
	return block;
}

function readConnection(id: string, map: ConnectionMap): Connection {
	return {
		id,
		from: map.get("from") as string,
		to: map.get("to") as string,
		label: textOf(map, "label"),
	};
}

export type BlockLink = { level: unknown; parentId: string | null };
export type RepairPlan = { remove: string[]; move: Map<string, string | null> };

export function planRepair(blocks: ReadonlyMap<string, BlockLink>): RepairPlan {
	const ids = [...blocks.keys()].sort();
	const parentOf = new Map(ids.map((id) => [id, blocks.get(id)?.parentId ?? null]));

	const remove = new Set<string>();
	for (const id of ids) {
		const seen = new Set<string>();
		let current: string | null = id;
		while (current !== null && !seen.has(current)) {
			if (!blocks.has(current)) {
				remove.add(id);
				break;
			}
			seen.add(current);
			current = parentOf.get(current) ?? null;
		}
	}

	const move = new Map<string, string | null>();
	const state = new Map<string, "walking" | "done">();
	for (const id of ids) {
		if (remove.has(id)) continue;
		const path: string[] = [];
		let current: string | null = id;
		while (current !== null && !remove.has(current) && !state.has(current)) {
			state.set(current, "walking");
			path.push(current);
			current = parentOf.get(current) ?? null;
		}
		if (current !== null && state.get(current) === "walking") {
			const cycle = path.slice(path.indexOf(current));
			const lowest = [...cycle].sort()[0] as string;
			parentOf.set(lowest, null);
			move.set(lowest, null);
		}
		for (const step of path) state.set(step, "done");
	}

	const isFunction = (id: string) => blocks.get(id)?.level === "function";
	for (const id of ids) {
		if (remove.has(id)) continue;
		const parentId = parentOf.get(id) ?? null;
		if (parentId === null || !isFunction(parentId)) continue;
		let target: string | null = parentId;
		while (target !== null && isFunction(target)) target = parentOf.get(target) ?? null;
		move.set(id, target);
	}

	const sortedMove = new Map([...move].sort(([a], [b]) => (a < b ? -1 : 1)));
	return { remove: [...remove].sort(), move: sortedMove };
}

export function docToSnapshot(doc: Y.Doc): Snapshot {
	const all = new Map<string, Block>();
	for (const [id, map] of blocksOf(doc).entries()) all.set(id, readBlock(id, map));
	const plan = planRepair(all);
	const removed = new Set(plan.remove);
	const blocks = [...all.values()]
		.filter((b) => !removed.has(b.id))
		.map((b) => (plan.move.has(b.id) ? { ...b, parentId: plan.move.get(b.id) ?? null } : b))
		.sort(compareIds);
	const kept = new Set(blocks.map((b) => b.id));
	const connections = [...connectionsOf(doc).entries()]
		.map(([id, map]) => readConnection(id, map))
		.filter((c) => kept.has(c.from) && kept.has(c.to))
		.sort(compareIds);
	return { schemaVersion: SCHEMA_VERSION, blocks, connections };
}
