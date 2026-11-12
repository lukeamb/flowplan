import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addBlock, deleteItem, docToSnapshot, edit, type Origin, originOf, setField, textField } from "@flowplan/core";
import type * as Y from "yjs";
import { sampleSnapshot } from "../../core/test/fixtures.ts";
import { connect, disconnect, start, tempRoot, waitFor, writeFlow } from "./helpers.ts";

const pseudocode = (doc: Y.Doc) => textField(doc, "b_api", "pseudocode").toString();

describe("two clients on one flow", () => {
	it("keep both edits on both clients when they type in the same block's pseudocode at the same time", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server } = await start({ root, debounceMs: 20 });
		const [ui, agent] = await Promise.all([connect(server, "main"), connect(server, "main")]);
		try {
			const rounds = 20;
			await Promise.all([
				(async () => {
					for (let i = 0; i < rounds; i++) {
						edit(ui.doc, "ui", () => textField(ui.doc, "b_api", "pseudocode").insert(0, `<u${i}>`));
						await new Promise((resolve) => setImmediate(resolve));
					}
				})(),
				(async () => {
					for (let i = 0; i < rounds; i++) {
						edit(agent.doc, "agent", () => {
							const text = textField(agent.doc, "b_api", "pseudocode");
							text.insert(text.length, `<a${i}>`);
						});
						await new Promise((resolve) => setImmediate(resolve));
					}
				})(),
			]);
			const hasAll = (text: string) =>
				Array.from({ length: rounds }, (_, i) => text.includes(`<u${i}>`) && text.includes(`<a${i}>`)).every(Boolean);
			await waitFor(() => hasAll(pseudocode(ui.doc)) && pseudocode(ui.doc) === pseudocode(agent.doc), 3000);
			assert.ok(pseudocode(ui.doc).includes("receive request\nvalidate token"));
			assert.equal(pseudocode(server.doc("main") as Y.Doc), pseudocode(ui.doc));
			await waitFor(() => hasAll(readFileSync(join(root, ".flowplan", "main.json"), "utf8")));
		} finally {
			disconnect(ui, agent);
			await server.close();
		}
	});

	it("carries the edit origin from one client to the other through the server", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server } = await start({ root });
		const [ui, agent] = await Promise.all([connect(server, "main"), connect(server, "main")]);
		const seen: (Origin | undefined)[] = [];
		ui.doc.on("afterTransaction", (tx: Y.Transaction) => {
			if (!tx.local) seen.push(originOf(tx));
		});
		try {
			setField(agent.doc, "agent", "b_api", "title", "from the agent");
			await waitFor(() => seen.includes("agent"));
			assert.deepEqual(
				seen.filter((origin) => origin !== undefined),
				["agent"],
			);
		} finally {
			disconnect(ui, agent);
			await server.close();
		}
	});
});

describe("orphan cleanup after remote updates", () => {
	it("removes a child block and a connection that another client added to a block deleted at the same time", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server } = await start({ root, debounceMs: 20 });
		const [a, b] = await Promise.all([connect(server, "main"), connect(server, "main")]);
		const originsAtA: (Origin | undefined)[] = [];
		try {
			b.provider.disconnect();
			addBlock(b.doc, "ui", { id: "b_new", level: "function", parentId: "b_api", title: "new()" });
			deleteItem(a.doc, "agent", "b_api");
			await waitFor(() => !(server.doc("main") as Y.Doc).getMap("blocks").has("b_api"));
			a.doc.on("afterTransaction", (tx: Y.Transaction) => {
				if (!tx.local) originsAtA.push(originOf(tx));
			});
			b.provider.connect();
			const clean = (doc: Y.Doc) => !doc.getMap("blocks").has("b_new") && !doc.getMap("blocks").has("b_api");
			await waitFor(() => b.provider.synced && clean(server.doc("main") as Y.Doc) && clean(a.doc) && clean(b.doc));
			for (const doc of [server.doc("main") as Y.Doc, a.doc, b.doc]) {
				assert.deepEqual(
					docToSnapshot(doc).blocks.map((block) => block.id),
					["b_root", "b_store"],
				);
			}
			await waitFor(() => !readFileSync(join(root, ".flowplan", "main.json"), "utf8").includes("b_new"));
			assert.equal(originsAtA.includes("agent"), false);
		} finally {
			disconnect(a, b);
			await server.close();
		}
	});
});

describe("edit-origin map", () => {
	const keys = (doc: Y.Doc) => [...doc.getMap("edit").keys()];

	it("removes the key of a client after that client disconnects", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server } = await start({ root });
		const clients = await Promise.all([connect(server, "main"), connect(server, "main"), connect(server, "main")]);
		const live = server.doc("main") as Y.Doc;
		try {
			for (const [i, client] of clients.entries())
				setField(client.doc, i === 0 ? "ui" : "agent", "b_api", "title", `t${i}`);
			await waitFor(() => keys(live).length === 3);
			assert.deepEqual(keys(live).sort(), clients.map((c) => String(c.doc.clientID)).sort());
			disconnect(clients[0] as (typeof clients)[0]);
			await waitFor(() => keys(live).length === 2);
			assert.equal(keys(live).includes(String(clients[0]?.doc.clientID)), false);
			await waitFor(() => keys(clients[1]?.doc as Y.Doc).length === 2);
		} finally {
			disconnect(...clients.slice(1));
			await server.close();
		}
	});

	it("does not grow without limit as clients come and go", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server } = await start({ root });
		const live = server.doc("main") as Y.Doc;
		try {
			for (let i = 0; i < 30; i++) {
				const client = await connect(server, "main");
				setField(client.doc, "agent", "b_api", "title", `command ${i}`);
				await waitFor(() => keys(live).includes(String(client.doc.clientID)));
				disconnect(client);
				await waitFor(() => keys(live).length === 0);
			}
			assert.equal(keys(live).length, 0);
			assert.equal(textField(live, "b_api", "title").toString(), "command 29");
		} finally {
			await server.close();
		}
	});
});

describe("awareness", () => {
	it("relays a client's focus state to the other client and removes it when that client disconnects", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		const { server } = await start({ root });
		const [ui, agent] = await Promise.all([connect(server, "main"), connect(server, "main")]);
		try {
			ui.provider.awareness.setLocalState({ canvas: ["b_root"], selected: ["b_api"] });
			const uiId = ui.doc.clientID;
			await waitFor(() => agent.provider.awareness.getStates().has(uiId));
			assert.deepEqual(agent.provider.awareness.getStates().get(uiId), { canvas: ["b_root"], selected: ["b_api"] });
			disconnect(ui);
			await waitFor(() => !agent.provider.awareness.getStates().has(uiId));
		} finally {
			disconnect(agent);
			await server.close();
		}
	});
});
