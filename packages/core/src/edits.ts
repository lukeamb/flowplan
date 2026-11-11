import * as Y from "yjs";
import type { z } from "zod";
import {
	type BlockMap,
	blocksOf,
	type ConnectionMap,
	connectionsOf,
	createBlockMap,
	createConnectionMap,
	reachableBlockIds,
} from "./doc.ts";
import { type Block, blockSchema, type Connection, connectionSchema, type Level, toJsonPath } from "./schema.ts";

export const ORIGINS = ["ui", "agent"] as const;
export type Origin = (typeof ORIGINS)[number];

export const EDIT_KEY = "edit";

export class FlowEditError extends Error {
	override name = "FlowEditError";
}

function isOrigin(value: unknown): value is Origin {
	return (ORIGINS as readonly unknown[]).includes(value);
}

function editMapOf(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap<unknown>(EDIT_KEY);
}

export function edit<T>(doc: Y.Doc, origin: Origin, change: () => T): T {
	if (!isOrigin(origin)) throw new FlowEditError(`origin must be one of ${ORIGINS.join(", ")}`);
	let result: T | undefined;
	doc.transact(() => {
		editMapOf(doc).set(String(doc.clientID), origin);
		result = change();
	}, origin);
	return result as T;
}

export function originsOf(transaction: Y.Transaction): Set<Origin> {
	if (isOrigin(transaction.origin)) return new Set([transaction.origin]);
	const origins = new Set<Origin>();
	const shared = transaction.doc.share.get(EDIT_KEY);
	const changedClients = shared ? transaction.changed.get(shared) : undefined;
	if (!changedClients) return origins;
	const editMap = editMapOf(transaction.doc);
	for (const client of changedClients) {
		const origin = client === null ? undefined : editMap.get(client);
		if (isOrigin(origin)) origins.add(origin);
	}
	return origins;
}

export function originOf(transaction: Y.Transaction): Origin | undefined {
	const origins = originsOf(transaction);
	return origins.size === 1 ? [...origins][0] : undefined;
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function createId(prefix: string): string {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
	let suffix = "";
	for (const byte of bytes) suffix += ID_ALPHABET[byte & 63];
	return `${prefix}_${suffix}`;
}

function check<T>(schema: z.ZodType<T>, value: unknown, path: PropertyKey[] = []): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = toJsonPath([...path, ...(issue?.path ?? [])]).replace(/^\$\.?/, "") || "value";
		throw new FlowEditError(`${where}: ${issue?.message ?? "not valid"}`);
	}
	return parsed.data;
}

function isUsed(doc: Y.Doc, id: string): boolean {
	return blocksOf(doc).has(id) || connectionsOf(doc).has(id);
}

function hasChildren(doc: Y.Doc, id: string): boolean {
	for (const block of blocksOf(doc).values()) if (block.get("parentId") === id) return true;
	return false;
}

function checkParent(doc: Y.Doc, childId: string, parentId: string | null): void {
	if (parentId === null) return;
	const parent = blocksOf(doc).get(parentId);
	if (!parent) throw new FlowEditError(`parentId: block '${parentId}' does not exist`);
	if (parent.get("level") === "function") {
		throw new FlowEditError(
			`parentId: block '${parentId}' is a function block, and a function block cannot be a parent`,
		);
	}
	let current: string | null = parentId;
	const visited = new Set<string>();
	while (current !== null && !visited.has(current)) {
		if (current === childId) throw new FlowEditError(`parentId: '${parentId}' would make a parent cycle`);
		visited.add(current);
		current = (blocksOf(doc).get(current)?.get("parentId") as string | null | undefined) ?? null;
	}
}

function checkBlockExists(doc: Y.Doc, id: string, field: string): void {
	if (!blocksOf(doc).has(id)) throw new FlowEditError(`${field}: block '${id}' does not exist`);
}

export type NewBlock = {
	id?: string;
	level: Level;
	parentId?: string | null;
	title?: string;
	pseudocode?: string;
	position?: { x: number; y: number };
	source?: string;
	meta?: Block["meta"];
};

export function addBlock(doc: Y.Doc, origin: Origin, input: NewBlock): string {
	const block = check(blockSchema, {
		...input,
		id: input.id ?? createId("b"),
		parentId: input.parentId ?? null,
		title: input.title ?? "",
		pseudocode: input.pseudocode ?? "",
		position: input.position ?? { x: 0, y: 0 },
	});
	if (isUsed(doc, block.id)) throw new FlowEditError(`id: '${block.id}' is already used`);
	checkParent(doc, block.id, block.parentId);
	edit(doc, origin, () => blocksOf(doc).set(block.id, createBlockMap(block)));
	return block.id;
}

export type NewConnection = { id?: string; from: string; to: string; label?: string };

export function addConnection(doc: Y.Doc, origin: Origin, input: NewConnection): string {
	const connection = check(connectionSchema, { ...input, id: input.id ?? createId("c"), label: input.label ?? "" });
	if (isUsed(doc, connection.id)) throw new FlowEditError(`id: '${connection.id}' is already used`);
	checkBlockExists(doc, connection.from, "from");
	checkBlockExists(doc, connection.to, "to");
	edit(doc, origin, () => connectionsOf(doc).set(connection.id, createConnectionMap(connection)));
	return connection.id;
}

const BLOCK_TEXT_FIELDS = ["title", "pseudocode"] as const;
const CONNECTION_TEXT_FIELDS = ["label"] as const;
export const BLOCK_FIELDS = [...BLOCK_TEXT_FIELDS, "level", "parentId", "position", "source", "meta"] as const;
export const CONNECTION_FIELDS = [...CONNECTION_TEXT_FIELDS, "from", "to"] as const;
const REMOVABLE_FIELDS = new Set(["source", "meta"]);

function itemOf(doc: Y.Doc, id: string): { kind: "block"; map: BlockMap } | { kind: "connection"; map: ConnectionMap } {
	const block = blocksOf(doc).get(id);
	if (block) return { kind: "block", map: block };
	const connection = connectionsOf(doc).get(id);
	if (connection) return { kind: "connection", map: connection };
	throw new FlowEditError(`no block or connection has the ID '${id}'`);
}

export function textField(doc: Y.Doc, id: string, field: string): Y.Text {
	const { kind, map } = itemOf(doc, id);
	const allowed: readonly string[] = kind === "block" ? BLOCK_TEXT_FIELDS : CONNECTION_TEXT_FIELDS;
	const text = map.get(field);
	if (!allowed.includes(field) || !(text instanceof Y.Text)) {
		throw new FlowEditError(`${field}: a ${kind} has no text field '${field}'`);
	}
	return text;
}

export function replaceText(text: Y.Text, value: string): void {
	const current = text.toString();
	let start = 0;
	while (start < current.length && start < value.length && current[start] === value[start]) start++;
	let end = 0;
	while (
		end < current.length - start &&
		end < value.length - start &&
		current[current.length - 1 - end] === value[value.length - 1 - end]
	) {
		end++;
	}
	const removed = current.length - start - end;
	if (removed > 0) text.delete(start, removed);
	const inserted = value.slice(start, value.length - end);
	if (inserted.length > 0) text.insert(start, inserted);
}

export function setField(doc: Y.Doc, origin: Origin, id: string, field: string, value: unknown): void {
	const { kind, map } = itemOf(doc, id);
	const fields: readonly string[] = kind === "block" ? BLOCK_FIELDS : CONNECTION_FIELDS;
	if (!fields.includes(field)) {
		throw new FlowEditError(`${field}: a ${kind} has no field '${field}'. Fields: ${fields.join(", ")}`);
	}
	const shape = (kind === "block" ? blockSchema.shape : connectionSchema.shape) as Record<string, z.ZodType>;
	const fieldSchema = shape[field] as z.ZodType;

	if (value === null && REMOVABLE_FIELDS.has(field)) {
		edit(doc, origin, () => map.delete(field));
		return;
	}
	const checked = check(fieldSchema, value, [field]);

	if (field === "level" && checked === "function" && hasChildren(doc, id)) {
		throw new FlowEditError(`level: block '${id}' has child blocks, and a function block cannot be a parent`);
	}
	if (field === "parentId") checkParent(doc, id, checked as string | null);
	if (field === "from" || field === "to") checkBlockExists(doc, checked as string, field);

	edit(doc, origin, () => {
		const current = map.get(field);
		if (current instanceof Y.Text) replaceText(current, checked as string);
		else map.set(field, structuredClone(checked));
	});
}

function descendantsOf(doc: Y.Doc, id: string): Set<string> {
	const children = new Map<string, string[]>();
	for (const [childId, block] of blocksOf(doc).entries()) {
		const parentId = block.get("parentId");
		if (typeof parentId === "string") children.set(parentId, [...(children.get(parentId) ?? []), childId]);
	}
	const found = new Set<string>([id]);
	const queue = [id];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		for (const child of children.get(next) ?? []) {
			if (!found.has(child)) {
				found.add(child);
				queue.push(child);
			}
		}
	}
	return found;
}

function removeBlocks(doc: Y.Doc, blockIds: Set<string>, extraConnections: Iterable<string> = []): string[] {
	const connectionIds = new Set(extraConnections);
	for (const [connectionId, connection] of connectionsOf(doc).entries()) {
		if (blockIds.has(connection.get("from") as string) || blockIds.has(connection.get("to") as string)) {
			connectionIds.add(connectionId);
		}
	}
	for (const blockId of blockIds) blocksOf(doc).delete(blockId);
	for (const connectionId of connectionIds) connectionsOf(doc).delete(connectionId);
	return [...blockIds, ...connectionIds];
}

export function deleteItem(doc: Y.Doc, origin: Origin, id: string): string[] {
	const { kind } = itemOf(doc, id);
	return edit(doc, origin, () => {
		if (kind === "connection") {
			connectionsOf(doc).delete(id);
			return [id];
		}
		return removeBlocks(doc, descendantsOf(doc, id));
	});
}

export function pruneOrphans(doc: Y.Doc, origin: Origin): string[] {
	const all = new Map<string, { level: string; parentId: string | null }>();
	for (const [id, block] of blocksOf(doc).entries()) {
		all.set(id, {
			level: block.get("level") as string,
			parentId: (block.get("parentId") as string | null | undefined) ?? null,
		});
	}
	const kept = reachableBlockIds(all);
	const orphans = new Set([...all.keys()].filter((id) => !kept.has(id)));
	const danglingConnections: string[] = [];
	for (const [id, connection] of connectionsOf(doc).entries()) {
		if (!kept.has(connection.get("from") as string) || !kept.has(connection.get("to") as string)) {
			danglingConnections.push(id);
		}
	}
	if (orphans.size === 0 && danglingConnections.length === 0) return [];
	return edit(doc, origin, () => removeBlocks(doc, orphans, danglingConnections));
}

export type { Block, Connection };
