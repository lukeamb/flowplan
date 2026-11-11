import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = new URL("../src/", import.meta.url);

describe("core module", () => {
	it("imports no Node built-in module, so a browser can load it", () => {
		const offenders = readdirSync(src)
			.filter((file) => file.endsWith(".ts"))
			.filter((file) =>
				/from\s+["'](node:|fs|path|crypto|child_process)/.test(readFileSync(new URL(file, src), "utf8")),
			);
		assert.deepEqual(offenders, []);
	});
});
