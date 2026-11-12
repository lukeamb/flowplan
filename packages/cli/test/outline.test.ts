import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isControlCharacter, type Snapshot } from "@flowplan/core";
import { formatOutline } from "../src/index.ts";

describe("formatOutline", () => {
	it("prints every control character in a printed field as a visible escape", () => {
		const snapshot = {
			schemaVersion: 1,
			blocks: [
				{
					id: "b\u001b[2J",
					level: "service\u0007",
					parentId: null,
					title: "Title\u001b]0;owned\u0007\nsecond line",
					pseudocode: "",
					position: { x: 0, y: 0 },
					source: "a.ts\u009b:1",
				},
			],
			connections: [{ id: "c1", from: "b\u001b[2J", to: "b\u001b[2J", label: "lab\u001bel\u0085" }],
		} as unknown as Snapshot;
		const text = formatOutline(snapshot, "main");
		assert.deepEqual(
			[...text].filter((char) => char !== "\n" && isControlCharacter(char.codePointAt(0) ?? 0)),
			[],
		);
		assert.match(text, /Title\\u001b\]0;owned\\u0007 second line/);
		assert.match(text, /"lab\\u001bel\\u0085"/);
	});
});
