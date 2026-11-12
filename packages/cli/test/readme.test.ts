import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { serializeSnapshot } from "@flowplan/core";
import { sampleSnapshot } from "../../core/test/fixtures.ts";
import { COMMANDS } from "../src/index.ts";
import { CLI, runCli, tempRoot, writeFlow } from "./helpers.ts";

const names = COMMANDS.map((command) => command.name);

describe("README agent guide", () => {
	const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
	const guide = readme.slice(readme.indexOf("## Agent guide"));

	it("tells an agent how to read, edit and watch a flow", () => {
		assert.ok(readme.includes("## Agent guide"));
		for (const name of names) assert.ok(guide.includes(`flowplan ${name}`), name);
		for (const heading of ["### Read a flow", "### Edit a flow", "### Watch the user"]) {
			assert.ok(guide.includes(heading), heading);
		}
	});

	it("documents a command that works from the planned repo, outside the flowplan repo", async () => {
		const root = tempRoot();
		await writeFlow(root, "main", sampleSnapshot());
		assert.ok(guide.includes("node <flowplan>/packages/cli/bin/flowplan.ts"));
		const show = await runCli(["show"], { cwd: root });
		assert.equal(show.code, 0, show.stderr);
		assert.match(show.stdout, /^flow main: /);
		const file = join(root, "draft.json");
		writeFileSync(file, serializeSnapshot(sampleSnapshot()));
		const validate = await runCli(["validate", "draft.json"], { cwd: root });
		assert.equal(validate.code, 0, validate.stderr);
		assert.ok(CLI.endsWith("packages/cli/bin/flowplan.ts"));
	});
});
