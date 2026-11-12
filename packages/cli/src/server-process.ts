import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGitignore, isRunning, readServerInfo, SERVER_FILE, type ServerInfo } from "@flowplan/server";
import { CliError } from "./errors.ts";

export const LOCK_FILE = "server.lock";
export const LOG_FILE = "server.log";
const POLL_MS = 50;

export function serverUrl(port: number): string {
	return `ws://127.0.0.1:${port}`;
}

export function flowDir(root: string): string {
	return join(root, ".flowplan");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runningServer(dir: string): Promise<ServerInfo | undefined> {
	const info = await readServerInfo(join(dir, SERVER_FILE));
	return info && typeof info.token === "string" && isRunning(info.pid) ? info : undefined;
}

async function tryLock(path: string): Promise<boolean> {
	try {
		const handle = await open(path, "wx");
		await handle.writeFile(`${process.pid}\n`);
		await handle.close();
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

async function clearStaleLock(path: string): Promise<void> {
	let pid: number;
	try {
		pid = Number.parseInt(await readFile(path, "utf8"), 10);
	} catch {
		return;
	}
	if (!Number.isInteger(pid) || !isRunning(pid)) await rm(path, { force: true });
}

function logTail(path: string, from: number): string {
	try {
		return readFileSync(path).subarray(from).toString("utf8").trim().split("\n").slice(-5).join("\n");
	} catch {
		return "";
	}
}

async function spawnServer(root: string, dir: string, deadline: number): Promise<ServerInfo> {
	const logPath = join(dir, LOG_FILE);
	const log = openSync(logPath, "a");
	const logStart = statSync(logPath).size;
	const bin = fileURLToPath(import.meta.resolve("@flowplan/server/bin"));
	const child = spawn(process.execPath, [bin, "--root", root], { detached: true, stdio: ["ignore", log, log] });
	closeSync(log);
	let exitCode: number | null = null;
	child.on("exit", (code) => {
		exitCode = code ?? 1;
	});
	child.unref();
	while (Date.now() < deadline) {
		const info = await readServerInfo(join(dir, SERVER_FILE));
		if (info && info.pid === child.pid) return info;
		if (exitCode !== null) {
			const other = await runningServer(dir);
			if (other) return other;
			const tail = logTail(logPath, logStart);
			throw new CliError(`the flowplan server did not start (exit code ${exitCode})${tail ? `:\n${tail}` : ""}`);
		}
		await sleep(POLL_MS);
	}
	child.kill();
	throw new CliError(`the flowplan server did not start in time; see ${logPath}`);
}

export async function ensureServer(root: string, timeoutMs = 15_000): Promise<ServerInfo> {
	const dir = flowDir(root);
	await mkdir(dir, { recursive: true });
	try {
		await ensureGitignore(dir);
	} catch (error) {
		throw new CliError(`the flowplan server cannot start: ${(error as Error).message}`);
	}
	const lockPath = join(dir, LOCK_FILE);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const live = await runningServer(dir);
		if (live) return live;
		if (await tryLock(lockPath)) {
			try {
				const started = await runningServer(dir);
				return started ?? (await spawnServer(root, dir, deadline));
			} finally {
				await rm(lockPath, { force: true });
			}
		}
		await clearStaleLock(lockPath);
		if (Date.now() > deadline) throw new CliError("another flowplan command did not finish the server start in time");
		await sleep(POLL_MS);
	}
}
