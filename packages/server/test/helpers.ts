import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Snapshot, serializeSnapshot } from "@flowplan/core";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { type FlowplanServer, type ServerOptions, startServer } from "../src/index.ts";

export function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "flowplan-server-"));
}

export async function writeFlow(root: string, name: string, snapshot: Snapshot | string): Promise<string> {
	await mkdir(join(root, ".flowplan"), { recursive: true });
	const path = join(root, ".flowplan", `${name}.json`);
	writeFileSync(path, typeof snapshot === "string" ? snapshot : serializeSnapshot(snapshot));
	return path;
}

export type Logged = string[];

export async function start(options: Partial<ServerOptions> & { root: string }): Promise<{
	server: FlowplanServer;
	logged: Logged;
}> {
	const logged: Logged = [];
	const server = await startServer({ log: (line) => logged.push(line), ...options });
	return { server, logged };
}

export async function connect(
	server: FlowplanServer,
	flow: string,
): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
	const doc = new Y.Doc();
	const provider = new WebsocketProvider(`ws://127.0.0.1:${server.port}`, flow, doc, {
		params: { token: server.token },
		disableBc: true,
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			provider.destroy();
			doc.destroy();
			reject(new Error(`client did not sync with flow '${flow}'`));
		}, 3000);
		provider.on("sync", (synced: boolean) => {
			if (synced) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	return { doc, provider };
}

export function disconnect(...clients: { provider: WebsocketProvider; doc: Y.Doc }[]): void {
	for (const { provider, doc } of clients) {
		provider.destroy();
		doc.destroy();
	}
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<number> {
	const started = Date.now();
	while (!(await condition())) {
		if (Date.now() - started > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return Date.now() - started;
}
