import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type * as Y from "yjs";
import { FlowRoom } from "./connection.ts";
import { FlowStore, isFlowName } from "./flows.ts";
import { checkHttp, checkUpgrade, type Gate } from "./security.ts";

export const HOST = "127.0.0.1";
export const DEFAULT_DEBOUNCE_MS = 500;
export const SERVER_FILE = "server.json";
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const IGNORED_PATTERNS = [SERVER_FILE, "*.tmp", "server.log", "server.lock"];

export type ServerOptions = {
	root: string;
	port?: number;
	debounceMs?: number;
	allowedOrigins?: readonly string[];
	log?: (line: string) => void;
	onSnapshotWrite?: (flow: string) => void;
};

export type ServerInfo = { pid: number; port: number; token: string };

export type FlowplanServer = {
	readonly port: number;
	readonly token: string;
	readonly dir: string;
	address(): AddressInfo;
	flowNames(): string[];
	doc(name: string): Y.Doc | undefined;
	close(): Promise<void>;
};

export function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function readServerInfo(path: string): Promise<ServerInfo | undefined> {
	try {
		const info = JSON.parse(await readFile(path, "utf8")) as Partial<ServerInfo>;
		return Number.isInteger(info.pid) && Number.isInteger(info.port) ? (info as ServerInfo) : undefined;
	} catch {
		return undefined;
	}
}

async function writePrivateFile(path: string, text: string): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	await rm(temp, { force: true });
	await writeFile(temp, text, { mode: 0o600, flag: "wx" });
	await rename(temp, path);
}

export async function ensureGitignore(dir: string): Promise<void> {
	const path = join(dir, ".gitignore");
	let text = "";
	try {
		const info = await lstat(path);
		if (!info.isFile()) throw new Error(`${path} is not a regular file, so the server does not write to it`);
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
	const missing = IGNORED_PATTERNS.filter((pattern) => !present.has(pattern));
	if (missing.length === 0) return;
	const separator = text === "" || text.endsWith("\n") ? "" : "\n";
	const temp = `${path}.${process.pid}.tmp`;
	await rm(temp, { force: true });
	await writeFile(temp, `${text}${separator}${missing.join("\n")}\n`, { flag: "wx" });
	await rename(temp, path);
}

function refuse(socket: Duplex, status: number, reason: string): void {
	const text = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 409: "Conflict" }[status] ?? "Error";
	socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}\n`);
}

function listen(http: Server, port: number): Promise<number> {
	return new Promise((resolvePort, reject) => {
		http.once("error", reject);
		http.listen(port, HOST, () => {
			http.off("error", reject);
			resolvePort((http.address() as AddressInfo).port);
		});
	});
}

export async function startServer(options: ServerOptions): Promise<FlowplanServer> {
	const log = options.log ?? ((line: string) => console.error(line));
	const dir = join(resolve(options.root), ".flowplan");
	const serverFile = join(dir, SERVER_FILE);
	const store = new FlowStore({
		dir,
		debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
		log,
		onSnapshotWrite: options.onSnapshotWrite,
	});
	await store.load();
	await ensureGitignore(dir);

	const running = await readServerInfo(serverFile);
	if (running && isRunning(running.pid)) {
		throw new Error(`a flowplan server is already running for ${dir} (pid ${running.pid}, port ${running.port})`);
	}

	const token = randomBytes(32).toString("base64url");
	const rooms = new Map<string, FlowRoom>();
	const roomFor = (name: string) => {
		let room = rooms.get(name);
		if (!room) {
			room = new FlowRoom(name, store.open(name), log);
			rooms.set(name, room);
		}
		return room;
	};

	const gate: Gate = { port: 0, token, allowedOrigins: options.allowedOrigins ?? [] };
	const http = createServer((req, res) => {
		const verdict = checkHttp(req.headers, gate);
		res.writeHead(verdict.ok ? 404 : verdict.status, { "Content-Type": "text/plain" });
		res.end(verdict.ok ? "not found\n" : `${verdict.reason}\n`);
	});
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

	http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		socket.on("error", () => socket.destroy());
		const url = new URL(req.url ?? "/", "http://placeholder");
		const verdict = checkUpgrade(req.headers, url.searchParams.get("token"), gate);
		if (!verdict.ok) return refuse(socket, verdict.status, verdict.reason);
		const name = url.pathname.slice(1);
		if (!isFlowName(name)) return refuse(socket, 400, "the path is not a valid flow name");
		if (store.hasFailed(name))
			return refuse(socket, 409, "the snapshot of this flow is not valid, so it is not loaded");
		wss.handleUpgrade(req, socket, head, (ws) => roomFor(name).join(ws));
	});

	const port = await listen(http, options.port ?? 0);
	gate.port = port;
	await writePrivateFile(serverFile, `${JSON.stringify({ pid: process.pid, port, token })}\n`);

	let closing: Promise<void> | undefined;
	return {
		port,
		token,
		dir,
		address: () => http.address() as AddressInfo,
		flowNames: () => store.names(),
		doc: (name) => store.get(name),
		close: () => {
			closing ??= (async () => {
				for (const room of rooms.values()) room.close();
				wss.close();
				http.closeAllConnections();
				await new Promise<void>((done) => http.close(() => done()));
				await store.close();
				const info = await readServerInfo(serverFile);
				if (info?.pid === process.pid && info.port === port) await rm(serverFile, { force: true });
			})();
			return closing;
		},
	};
}
