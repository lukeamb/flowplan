import { EDIT_KEY, repairFlow } from "@flowplan/core";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const PING_INTERVAL_MS = 30_000;

type Client = { socket: WebSocket; clientIds: Set<number>; awarenessIds: Set<number>; alive: boolean };

export class FlowRoom {
	readonly awareness: awarenessProtocol.Awareness;
	private readonly clients = new Map<WebSocket, Client>();
	private readonly pinger: NodeJS.Timeout;

	readonly name: string;
	readonly doc: Y.Doc;
	private readonly log: (line: string) => void;

	constructor(name: string, doc: Y.Doc, log: (line: string) => void) {
		this.name = name;
		this.doc = doc;
		this.log = log;
		this.awareness = new awarenessProtocol.Awareness(doc);
		this.awareness.setLocalState(null);
		doc.on("update", (update: Uint8Array, origin: unknown) => this.onUpdate(update, origin));
		doc.on("afterTransaction", (transaction: Y.Transaction) => this.afterTransaction(transaction));
		this.awareness.on("update", (change: AwarenessChange, origin: unknown) => this.onAwareness(change, origin));
		this.pinger = setInterval(() => this.ping(), PING_INTERVAL_MS);
	}

	join(socket: WebSocket): void {
		const client: Client = { socket, clientIds: new Set(), awarenessIds: new Set(), alive: true };
		this.clients.set(socket, client);
		socket.binaryType = "arraybuffer";
		socket.on("message", (data: ArrayBuffer) => this.onMessage(client, new Uint8Array(data)));
		socket.on("pong", () => {
			client.alive = true;
		});
		socket.on("close", () => this.leave(client));
		socket.on("error", (error) => this.log(`flow '${this.name}': websocket error: ${error.message}`));

		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeSyncStep1(encoder, this.doc);
		this.send(client, encoding.toUint8Array(encoder));
		this.sendAwarenessStates(client);
	}

	connectionCount(): number {
		return this.clients.size;
	}

	close(): void {
		clearInterval(this.pinger);
		for (const client of this.clients.values()) client.socket.terminate();
		this.awareness.destroy();
	}

	private onMessage(client: Client, message: Uint8Array): void {
		try {
			const decoder = decoding.createDecoder(message);
			const encoder = encoding.createEncoder();
			const type = decoding.readVarUint(decoder);
			if (type === MESSAGE_SYNC) {
				encoding.writeVarUint(encoder, MESSAGE_SYNC);
				syncProtocol.readSyncMessage(decoder, encoder, this.doc, client);
				if (encoding.length(encoder) > 1) this.send(client, encoding.toUint8Array(encoder));
			} else if (type === MESSAGE_AWARENESS) {
				awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), client);
			} else if (type === MESSAGE_QUERY_AWARENESS) {
				this.sendAwarenessStates(client);
			} else {
				throw new Error(`unknown message type ${type}`);
			}
		} catch (error) {
			this.log(
				`flow '${this.name}': closed a client that sent a message that is not valid: ${(error as Error).message}`,
			);
			client.socket.close(1003);
		}
	}

	private onUpdate(update: Uint8Array, origin: unknown): void {
		const sender = this.clientOf(origin);
		if (sender) for (const id of Y.parseUpdateMeta(update).from.keys()) sender.clientIds.add(id);
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeUpdate(encoder, update);
		const message = encoding.toUint8Array(encoder);
		for (const client of this.clients.values()) this.send(client, message);
	}

	private afterTransaction(transaction: Y.Transaction): void {
		if (!this.clientOf(transaction.origin)) return;
		try {
			const { removed, moved } = repairFlow(this.doc);
			if (moved.length > 0) {
				this.log(`flow '${this.name}': moved blocks out of a parent cycle or a function parent: ${moved.join(", ")}`);
			}
			if (removed.length > 0) {
				this.log(`flow '${this.name}': removed items whose parent or end no longer exists: ${removed.join(", ")}`);
			}
		} catch (error) {
			this.log(`flow '${this.name}': flow repair failed: ${(error as Error).message}`);
		}
	}

	private onAwareness(change: AwarenessChange, origin: unknown): void {
		const changed = [...change.added, ...change.updated, ...change.removed];
		const sender = this.clientOf(origin);
		if (sender) {
			for (const id of [...change.added, ...change.updated]) {
				sender.awarenessIds.add(id);
				sender.clientIds.add(id);
			}
		}
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
		encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
		const message = encoding.toUint8Array(encoder);
		for (const client of this.clients.values()) this.send(client, message);
	}

	private leave(client: Client): void {
		if (!this.clients.delete(client.socket)) return;
		awarenessProtocol.removeAwarenessStates(this.awareness, [...client.awarenessIds], null);
		this.removeDisconnectedOrigins();
	}

	private removeDisconnectedOrigins(): void {
		const connected = new Set<string>();
		for (const client of this.clients.values()) for (const id of client.clientIds) connected.add(String(id));
		const editMap = this.doc.getMap(EDIT_KEY);
		const stale = [...editMap.keys()].filter((key) => !connected.has(key));
		if (stale.length === 0) return;
		this.doc.transact(() => {
			for (const key of stale) editMap.delete(key);
		});
	}

	private clientOf(origin: unknown): Client | undefined {
		return origin && typeof origin === "object" && "socket" in origin
			? this.clients.get((origin as Client).socket)
			: undefined;
	}

	private sendAwarenessStates(client: Client): void {
		const ids = [...this.awareness.getStates().keys()];
		if (ids.length === 0) return;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
		encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids));
		this.send(client, encoding.toUint8Array(encoder));
	}

	private send(client: Client, message: Uint8Array): void {
		if (client.socket.readyState !== client.socket.OPEN) return;
		client.socket.send(message, (error) => {
			if (error) client.socket.terminate();
		});
	}

	private ping(): void {
		for (const client of this.clients.values()) {
			if (!client.alive) {
				client.socket.terminate();
				continue;
			}
			client.alive = false;
			client.socket.ping();
		}
	}
}

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };
