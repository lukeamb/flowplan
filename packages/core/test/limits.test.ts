import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_MESSAGE_BYTES, SYNC_FRAME_OVERHEAD_BYTES, syncFrameBytes } from "../src/index.ts";

describe("message limit", () => {
	it("is 16 MiB, and a sync frame adds a small fixed overhead to an update", () => {
		assert.equal(MAX_MESSAGE_BYTES, 16 * 1024 * 1024);
		assert.equal(syncFrameBytes(100), 100 + SYNC_FRAME_OVERHEAD_BYTES);
		assert.ok(SYNC_FRAME_OVERHEAD_BYTES >= 7 && SYNC_FRAME_OVERHEAD_BYTES <= 16);
	});
});
