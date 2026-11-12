import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempRoot } from "./helpers.ts";

const repo = new URL("../../../", import.meta.url);

describe("start command", () => {
	it("is the documented 'npm start' script", () => {
		const manifest = JSON.parse(readFileSync(new URL("package.json", repo), "utf8"));
		assert.equal(manifest.scripts.start, "node packages/server/bin/flowplan-server.ts");
		assert.match(readFileSync(new URL("README.md", repo), "utf8"), /npm start/);
	});

	it("exports its bin path for the CLI, outside node_modules", () => {
		const path = fileURLToPath(import.meta.resolve("@flowplan/server/bin"));
		assert.equal(path, fileURLToPath(new URL("packages/server/bin/flowplan-server.ts", repo)));
		assert.equal(realpathSync(path).includes("node_modules"), false);
	});

	it("starts the server for a root, prints its URL, and removes server.json when it stops", async () => {
		const root = tempRoot();
		const child = spawn(process.execPath, ["packages/server/bin/flowplan-server.ts", "--root", root], {
			cwd: repo,
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			const line = await new Promise<string>((resolve, reject) => {
				let out = "";
				child.stdout.on("data", (chunk) => {
					out += chunk;
					if (out.includes("\n")) resolve(out.trim());
				});
				child.on("exit", (code) => reject(new Error(`server exited with code ${code}`)));
			});
			const info = JSON.parse(readFileSync(join(root, ".flowplan", "server.json"), "utf8"));
			assert.equal(info.pid, child.pid);
			assert.equal(line, `flowplan server: http://127.0.0.1:${info.port} (flows in ${join(root, ".flowplan")})`);
			assert.equal(line.includes(info.token), false);
		} finally {
			const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
			child.kill("SIGTERM");
			assert.equal(await exited, 0);
		}
		assert.equal(existsSync(join(root, ".flowplan", "server.json")), false);
	});

	it("exits with a non-zero code and a message for an unknown option", async () => {
		const child = spawn(process.execPath, ["packages/server/bin/flowplan-server.ts", "--bogus"], { cwd: repo });
		let err = "";
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
		assert.notEqual(code, 0);
		assert.match(err, /--bogus/);
	});
});
