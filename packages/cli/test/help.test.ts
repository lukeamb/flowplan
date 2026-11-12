import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMANDS } from "../src/index.ts";
import { runCli } from "./helpers.ts";

const names = COMMANDS.map((command) => command.name);

describe("help", () => {
	it("has every command of the agent interface", () => {
		assert.deepEqual(names, ["add-block", "set", "connect", "delete", "import", "show", "validate", "focus", "watch"]);
	});

	for (const name of names) {
		it(`flowplan ${name} --help prints its usage and exits with code 0`, async () => {
			const run = await runCli([name, "--help"]);
			assert.equal(run.code, 0, run.stderr);
			assert.match(run.stdout, new RegExp(`^Usage: flowplan ${name}`));
			assert.equal(run.stderr, "");
		});
	}

	it("flowplan --help lists every command", async () => {
		const run = await runCli(["--help"]);
		assert.equal(run.code, 0);
		for (const name of names) assert.match(run.stdout, new RegExp(`^  ${name} `, "m"));
	});

	it("exits with code 2 and prints the usage for an unknown command or option", async () => {
		const unknown = await runCli(["frobnicate"]);
		assert.equal(unknown.code, 2);
		assert.match(unknown.stderr, /unknown command 'frobnicate'/);
		const option = await runCli(["show", "--bogus"]);
		assert.equal(option.code, 2);
		assert.match(option.stderr, /--bogus/);
		assert.equal((await runCli([])).code, 2);
	});
});
