import {
	blocksOf,
	connectionsOf,
	describeFocus,
	docToSnapshot,
	type Origin,
	originsOf,
	type Presence,
	parsePresence,
} from "@flowplan/core";
import type * as Y from "yjs";
import type { FlowConnection } from "./connection.ts";

export type WatchIo = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
type Kind = "block" | "connection";
type Change = { kind: Kind; id: string; action: "add" | "update" | "delete"; fields: Set<string> };
type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

export function watchFlow(connection: FlowConnection, flow: string, io: WatchIo): Promise<number> {
	const { doc, provider } = connection;
	const awareness = provider.awareness;
	const pending = new Map<string, Change>();
	let stopping = false;

	const emit = (event: Record<string, unknown>) => {
		io.stdout.write(`${JSON.stringify({ ...event, flow, at: new Date().toISOString() })}\n`);
	};

	const record = (kind: Kind) => (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		for (const event of events) {
			const [id, field] = event.path as string[];
			if (id === undefined) {
				for (const [key, change] of event.changes.keys) {
					const action = change.action === "add" ? "add" : change.action === "delete" ? "delete" : "update";
					const entry = pending.get(`${kind}:${key}`);
					if (entry) entry.action = action;
					else pending.set(`${kind}:${key}`, { kind, id: key, action, fields: new Set() });
				}
				continue;
			}
			const key = `${kind}:${id}`;
			const entry = pending.get(key) ?? { kind, id, action: "update" as const, fields: new Set<string>() };
			pending.set(key, entry);
			if (field !== undefined) entry.fields.add(field);
			else for (const changed of (event as Y.YMapEvent<unknown>).keysChanged) entry.fields.add(changed);
		}
	};
	blocksOf(doc).observeDeep(record("block"));
	connectionsOf(doc).observeDeep(record("connection"));

	doc.on("afterTransaction", (transaction: Y.Transaction) => {
		if (pending.size === 0) return;
		const changes = [...pending.values()].sort((a, b) => (`${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1));
		pending.clear();
		const origins = [...originsOf(transaction)].sort();
		const snapshot = docToSnapshot(doc);
		const items = new Map<string, unknown>([
			...snapshot.blocks.map((b): [string, unknown] => [`block:${b.id}`, b]),
			...snapshot.connections.map((c): [string, unknown] => [`connection:${c.id}`, c]),
		]);
		emit({
			type: "edit",
			origin: origins.length === 1 ? origins[0] : origins.length === 0 ? "server" : "mixed",
			...(origins.length > 1 ? { origins } : {}),
			changes: changes.map((change) => {
				const item = items.get(`${change.kind}:${change.id}`);
				return {
					kind: change.kind,
					id: change.id,
					action: change.action,
					...(change.action === "update" ? { fields: [...change.fields].sort() } : {}),
					...(change.action !== "delete" && item ? { item } : {}),
				};
			}),
		});
	});

	const lastFocus = new Map<number, { kind: Origin; key: string }>();
	const showFocus = (client: number, presence: Presence | undefined) => {
		if (!presence?.focus) return;
		const key = JSON.stringify(presence.focus);
		if (lastFocus.get(client)?.key === key) return;
		lastFocus.set(client, { kind: presence.kind, key });
		emit({ type: "focus", origin: presence.kind, client, ...describeFocus(doc, presence.focus) });
	};
	for (const [client, state] of awareness.getStates()) {
		if (client !== doc.clientID) showFocus(client, parsePresence(state));
	}
	awareness.on("change", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
		if (origin === "local") return;
		for (const client of [...added, ...updated]) {
			if (client !== doc.clientID) showFocus(client, parsePresence(awareness.getStates().get(client)));
		}
		for (const client of removed) {
			const last = lastFocus.get(client);
			if (!last) continue;
			lastFocus.delete(client);
			emit({ type: "focus", origin: last.kind, client, left: true });
		}
	});

	return new Promise<number>((resolve) => {
		const stop = (code: number) => {
			if (stopping) return;
			stopping = true;
			connection.close().then(
				() => resolve(code),
				() => resolve(code),
			);
		};
		provider.on("connection-close", () => {
			if (stopping) return;
			io.stderr.write("flowplan watch: the connection to the flowplan server closed\n");
			stop(1);
		});
		process.once("SIGINT", () => stop(0));
		process.once("SIGTERM", () => stop(0));
		io.stdout.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE") stop(0);
		});
		io.stderr.write(`flowplan watch: watching flow '${flow}'\n`);
	});
}
