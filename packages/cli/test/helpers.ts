import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Snapshot, serializeSnapshot } from "@flowplan/core";
import { type FlowplanServer, startServer } from "@flowplan/server";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

export const CLI = fileURLToPath(new URL("../bin/flowplan.ts", import.meta.url));

export function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "flowplan-cli-"));
}

export async function writeFlow(root: string, name: string, snapshot: Snapshot | string): Promise<string> {
	await mkdir(join(root, ".flowplan"), { recursive: true });
	const path = join(root, ".flowplan", `${name}.json`);
	writeFileSync(path, typeof snapshot === "string" ? snapshot : serializeSnapshot(snapshot));
	return path;
}

export type Run = { code: number | null; stdout: string; stderr: string; ms: number };

export function runCli(
	args: string[],
	options: { cwd?: string; stdin?: string; timeoutMs?: number } = {},
): Promise<Run> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, ...args], {
			cwd: options.cwd ?? tmpdir(),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`flowplan ${args.join(" ")} did not finish: ${stderr}`));
		}, options.timeoutMs ?? 15_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, ms: Date.now() - started });
		});
		child.stdin.end(options.stdin ?? "");
	});
}

export function serverInfo(root: string): { pid: number; port: number; token: string } | undefined {
	const path = join(root, ".flowplan", "server.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

export function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function serverProcesses(root: string): number[] {
	const lines = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).split("\n");
	return lines
		.filter((line) => line.includes("flowplan-server.ts") && line.includes(root))
		.map((line) => Number.parseInt(line.trim(), 10));
}

export async function stopSpawnedServers(root: string): Promise<void> {
	for (const pid of serverProcesses(root)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
		await waitFor(() => !isRunning(pid), 5000);
	}
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<number> {
	const started = Date.now();
	while (!(await condition())) {
		if (Date.now() - started > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return Date.now() - started;
}

export async function startTestServer(root: string, debounceMs?: number): Promise<FlowplanServer> {
	return startServer({ root, log: () => {}, ...(debounceMs === undefined ? {} : { debounceMs }) });
}

export type Client = { doc: Y.Doc; provider: WebsocketProvider; close(): void };

export async function connectClient(port: number, token: string, flow = "main"): Promise<Client> {
	const doc = new Y.Doc();
	const provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, flow, doc, { params: { token }, disableBc: true });
	const close = () => {
		provider.destroy();
		doc.destroy();
	};
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			close();
			reject(new Error("test client did not sync"));
		}, 3000);
		provider.on("sync", (synced: boolean) => {
			if (synced) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	return { doc, provider, close };
}
