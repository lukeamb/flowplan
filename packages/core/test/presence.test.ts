import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeFocus, formatFocus, PRESENCE_KEY, parsePresence, presenceState, snapshotToDoc } from "../src/index.ts";
import { sampleSnapshot } from "./fixtures.ts";

describe("presence state", () => {
	it("round-trips a UI presence with focus through the awareness state shape", () => {
		const state = presenceState({ kind: "ui", focus: { canvas: ["b_root", "b_api"], selected: ["b_login"] } });
		assert.deepEqual(Object.keys(state), [PRESENCE_KEY]);
		assert.deepEqual(parsePresence(state), {
			kind: "ui",
			focus: { canvas: ["b_root", "b_api"], selected: ["b_login"] },
		});
	});

	it("accepts a presence with no focus", () => {
		assert.deepEqual(parsePresence(presenceState({ kind: "agent" })), { kind: "agent" });
	});

	it("gives no presence for a state that is not a flowplan presence", () => {
		for (const state of [null, undefined, {}, { [PRESENCE_KEY]: { kind: "robot" } }, { [PRESENCE_KEY]: "ui" }]) {
			assert.equal(parsePresence(state), undefined, JSON.stringify(state));
		}
		const bad = { [PRESENCE_KEY]: { kind: "ui", focus: { canvas: ["../x"], selected: [] } } };
		assert.equal(parsePresence(bad), undefined);
	});
});

describe("describeFocus", () => {
	it("gives the title of each block on the canvas path and of each selected block", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		assert.deepEqual(describeFocus(doc, { canvas: ["b_root", "b_api"], selected: ["b_login", "b_gone"] }), {
			canvas: [
				{ id: "b_root", title: "Auth" },
				{ id: "b_api", title: "API service" },
			],
			selected: [
				{ id: "b_login", title: "login()" },
				{ id: "b_gone", title: null },
			],
		});
	});

	it("formats the canvas path and the selection as plain text", () => {
		const doc = snapshotToDoc(sampleSnapshot());
		const view = describeFocus(doc, { canvas: ["b_root", "b_api"], selected: ["b_login", "b_store"] });
		assert.equal(
			formatFocus(view),
			"canvas: Top › Auth › API service\nselected: login() (b_login), User store (b_store)\n",
		);
		assert.equal(formatFocus(describeFocus(doc, { canvas: [], selected: [] })), "canvas: Top\nselected: (none)\n");
	});
});
