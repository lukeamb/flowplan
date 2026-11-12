import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { clearStaleLock, tryLock } from "../src/index.ts";
import { tempRoot } from "./helpers.ts";

describe("server start lock", () => {
	it("creates the lock with this process's pid in it, in one step, and refuses a second lock", async () => {
		const dir = tempRoot();
		const lock = join(dir, "server.lock");
		assert.equal(await tryLock(lock), true);
		assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
		assert.equal(await tryLock(lock), false);
		assert.deepEqual(readdirSync(dir), ["server.lock"]);
	});

	it("keeps a lock that names a running process", async () => {
		const lock = join(tempRoot(), "server.lock");
		writeFileSync(lock, `${process.pid}\n`);
		await clearStaleLock(lock);
		assert.equal(existsSync(lock), true);
	});

	it("removes a lock that names a process that is not running", async () => {
		const lock = join(tempRoot(), "server.lock");
		writeFileSync(lock, `${2 ** 22 + 99}\n`);
		await clearStaleLock(lock);
		assert.equal(existsSync(lock), false);
	});

	it("keeps a new lock that has no pid yet, and removes one that has had no pid for 10 seconds", async () => {
		const lock = join(tempRoot(), "server.lock");
		writeFileSync(lock, "");
		await clearStaleLock(lock);
		assert.equal(existsSync(lock), true);
		const old = new Date(Date.now() - 11_000);
		utimesSync(lock, old, old);
		await clearStaleLock(lock);
		assert.equal(existsSync(lock), false);
	});
});
