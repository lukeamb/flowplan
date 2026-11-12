import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ParseArgsConfig } from "node:util";
import {
	addBlock,
	addConnection,
	deleteItem,
	describeFocus,
	docToSnapshot,
	FlowEditError,
	formatFocus,
	importSnapshot,
	type Level,
	parsePresence,
	parseSnapshot,
	type Snapshot,
	setField,
} from "@flowplan/core";
import { isFlowName } from "@flowplan/server";
import type * as Y from "yjs";
import { openFlow } from "./connection.ts";
import { CliError, UsageError } from "./errors.ts";
import { count, formatOutline } from "./outline.ts";
import { ensureServer, flowDir, runningServer } from "./server-process.ts";
import { watchFlow } from "./watch.ts";

export type Io = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; stdin: NodeJS.ReadableStream };
type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
export type Context = { values: Values; positionals: string[]; root: string; flow: string; io: Io };
type Options = NonNullable<ParseArgsConfig["options"]>;

export type Command = {
	name: string;
	args: string;
	summary: string;
	details: string;
	options: Options;
	positionals: [min: number, max: number];
	run(context: Context): Promise<number>;
};

export const COMMON_OPTIONS: Options = {
	root: { type: "string" },
	flow: { type: "string" },
	help: { type: "boolean" },
};

const COMMON_HELP = `  --root <dir>   The repo that holds .flowplan/. Default: the current directory.
  --flow <name>  The flow. Default: main.
  --help         Print this help.`;

const AGENT = "agent";

async function withLiveFlow<T>(context: Context, change: (doc: Y.Doc) => T): Promise<T> {
	const info = await ensureServer(context.root);
	const connection = await openFlow(info, context.flow);
	try {
		return change(connection.doc);
	} finally {
		await connection.close();
	}
}

function text(values: Values, name: string): string | undefined {
	const value = values[name];
	return typeof value === "string" ? value : undefined;
}

function number(values: Values, name: string): number {
	const raw = text(values, name);
	if (raw === undefined) return 0;
	const value = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(value)) throw new UsageError(`--${name} must be a number`);
	return value;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
	let data = "";
	for await (const chunk of stream) data += chunk;
	return data;
}

export function parseValue(field: string, raw: string): unknown {
	if (field === "parentId") return raw === "null" ? null : raw;
	if (field === "source") return raw === "null" || raw === "" ? null : raw;
	if (field === "position") {
		const pair = /^\s*(-?[0-9.eE+-]+)\s*,\s*(-?[0-9.eE+-]+)\s*$/.exec(raw);
		if (pair) return { x: Number(pair[1]), y: Number(pair[2]) };
		try {
			return JSON.parse(raw);
		} catch {
			throw new CliError(`position must be "x,y" or a JSON object such as {"x":1,"y":2}`);
		}
	}
	if (field === "meta") {
		if (raw === "null") return null;
		try {
			return JSON.parse(raw);
		} catch {
			throw new CliError("meta must be a JSON object");
		}
	}
	return raw;
}

async function readSnapshotFile(file: string): Promise<Snapshot> {
	let content: string;
	try {
		content = await readFile(file, "utf8");
	} catch (error) {
		throw new CliError(`cannot read ${file}: ${(error as Error).message}`);
	}
	const result = parseSnapshot(content);
	if (!result.ok) {
		throw new CliError(
			`${file} is not a valid flow snapshot:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`,
		);
	}
	return result.snapshot;
}

export const COMMANDS: Command[] = [
	{
		name: "add-block",
		args: "--level <level> [options]",
		summary: "Add a block to the live flow. Prints its new ID.",
		details: `  --level <level>      architecture, service or function. Required.
  --parent <id>        The block whose child canvas holds the new block. Default: the top canvas.
  --title <text>       The title.
  --pseudocode <text>  The pseudocode.
  --source <path:line> A link to code.
  --x <n>, --y <n>     The position on the canvas. Default: 0, 0.
  --id <id>            Use this ID. Default: a new random ID.`,
		options: {
			level: { type: "string" },
			parent: { type: "string" },
			title: { type: "string" },
			pseudocode: { type: "string" },
			source: { type: "string" },
			x: { type: "string" },
			y: { type: "string" },
			id: { type: "string" },
		},
		positionals: [0, 0],
		async run(context) {
			const { values } = context;
			const level = text(values, "level");
			if (!level) throw new UsageError("--level is required");
			const position = { x: number(values, "x"), y: number(values, "y") };
			const id = await withLiveFlow(context, (doc) =>
				addBlock(doc, AGENT, {
					level: level as Level,
					position,
					...(text(values, "id") !== undefined ? { id: text(values, "id") } : {}),
					...(text(values, "parent") !== undefined ? { parentId: text(values, "parent") } : {}),
					...(text(values, "title") !== undefined ? { title: text(values, "title") } : {}),
					...(text(values, "pseudocode") !== undefined ? { pseudocode: text(values, "pseudocode") } : {}),
					...(text(values, "source") !== undefined ? { source: text(values, "source") } : {}),
				}),
			);
			context.io.stdout.write(`${id}\n`);
			return 0;
		},
	},
	{
		name: "set",
		args: "<id> <field> <value>",
		summary: "Set one field of a block or a connection in the live flow.",
		details: `  Block fields: title, pseudocode, level, parentId, position, source, meta.
  Connection fields: label, from, to.
  parentId null, source null and meta null clear the value. position takes "x,y" or a JSON object.
  meta takes a JSON object. Put -- before a value that starts with "-".
  --stdin              Read the value from stdin, for example long pseudocode.`,
		options: { stdin: { type: "boolean" } },
		positionals: [2, 3],
		async run(context) {
			const [id, field, given] = context.positionals as [string, string, string | undefined];
			const fromStdin = context.values.stdin === true;
			if (fromStdin === (given !== undefined)) {
				throw new UsageError("give the value as the third argument or with --stdin, not both");
			}
			const raw = fromStdin ? await readAll(context.io.stdin) : (given as string);
			const value = parseValue(field, raw);
			await withLiveFlow(context, (doc) => setField(doc, AGENT, id, field, value));
			return 0;
		},
	},
	{
		name: "connect",
		args: "<from> <to> [options]",
		summary: "Add a connection from one block to another. Prints its new ID.",
		details: `  --label <text>       The data that moves along the connection.
  --id <id>            Use this ID. Default: a new random ID.`,
		options: { label: { type: "string" }, id: { type: "string" } },
		positionals: [2, 2],
		async run(context) {
			const [from, to] = context.positionals as [string, string];
			const id = await withLiveFlow(context, (doc) =>
				addConnection(doc, AGENT, {
					from,
					to,
					...(text(context.values, "label") !== undefined ? { label: text(context.values, "label") } : {}),
					...(text(context.values, "id") !== undefined ? { id: text(context.values, "id") } : {}),
				}),
			);
			context.io.stdout.write(`${id}\n`);
			return 0;
		},
	},
	{
		name: "delete",
		args: "<id>",
		summary: "Delete a block or a connection. A block takes its child canvas and its connections with it.",
		details: "",
		options: {},
		positionals: [1, 1],
		async run(context) {
			await withLiveFlow(context, (doc) => deleteItem(doc, AGENT, context.positionals[0] as string));
			return 0;
		},
	},
	{
		name: "import",
		args: "<file>",
		summary: "Add every block and connection in a snapshot file to the live flow, in one transaction.",
		details: `  The file must be a valid snapshot on its own. No ID in it may already be in the flow.
  Import only adds: it never changes or deletes a block that exists.`,
		options: {},
		positionals: [1, 1],
		async run(context) {
			const snapshot = await readSnapshotFile(resolve(context.positionals[0] as string));
			const added = await withLiveFlow(context, (doc) => importSnapshot(doc, AGENT, snapshot));
			context.io.stdout.write(`imported ${count(added.blocks, "block")}, ${count(added.connections, "connection")}\n`);
			return 0;
		},
	},
	{
		name: "show",
		args: "[flow]",
		summary: "Print an outline of the flow: each block's ID, level and title, and the connections.",
		details: "  Reads the live flow when the server runs, and the snapshot file when it does not.",
		options: {},
		positionals: [0, 1],
		async run(context) {
			const flow = context.positionals[0] ?? context.flow;
			if (!isFlowName(flow)) throw new UsageError(`'${flow}' is not a valid flow name`);
			const dir = flowDir(context.root);
			const file = join(dir, `${flow}.json`);
			const info = await runningServer(dir);
			let snapshot: Snapshot;
			if (info) {
				const connection = await openFlow(info, flow);
				snapshot = docToSnapshot(connection.doc);
				await connection.close();
				if (snapshot.blocks.length === 0 && !(await exists(file))) throw new CliError(`no flow '${flow}' in ${dir}`);
			} else {
				if (!(await exists(file))) throw new CliError(`no flow '${flow}' in ${dir}`);
				snapshot = await readSnapshotFile(file);
			}
			context.io.stdout.write(formatOutline(snapshot, flow));
			return 0;
		},
	},
	{
		name: "validate",
		args: "<file>",
		summary: "Check a file against the snapshot schema. Needs no server.",
		details: "  Prints the JSON path and the message of each error on stderr, and exits with code 1.",
		options: {},
		positionals: [1, 1],
		async run(context) {
			const file = resolve(context.positionals[0] as string);
			let content: string;
			try {
				content = await readFile(file, "utf8");
			} catch (error) {
				throw new CliError(`cannot read ${file}: ${(error as Error).message}`);
			}
			const result = parseSnapshot(content);
			if (!result.ok) {
				for (const error of result.errors) context.io.stderr.write(`${error.path}: ${error.message}\n`);
				return 1;
			}
			const { blocks, connections } = result.snapshot;
			context.io.stdout.write(`valid: ${count(blocks.length, "block")}, ${count(connections.length, "connection")}\n`);
			return 0;
		},
	},
	{
		name: "focus",
		args: "",
		summary: "Print the user's current canvas path and selected blocks, once.",
		details:
			"  Reads the focus of a UI client. With more than one UI client, it uses the state that this command received last.\n  Starts no server.",
		options: {},
		positionals: [0, 0],
		async run(context) {
			const info = await runningServer(flowDir(context.root));
			if (!info) {
				context.io.stdout.write("no focus: the flowplan server is not running\n");
				return 0;
			}
			const connection = await openFlow(info, context.flow);
			try {
				const awareness = connection.provider.awareness;
				let latest: { focus: NonNullable<ReturnType<typeof parsePresence>>["focus"]; at: number } | undefined;
				for (const [client, state] of awareness.getStates()) {
					if (client === connection.doc.clientID) continue;
					const presence = parsePresence(state);
					if (presence?.kind !== "ui" || !presence.focus) continue;
					const at = awareness.meta.get(client)?.lastUpdated ?? 0;
					if (!latest || at > latest.at) latest = { focus: presence.focus, at };
				}
				context.io.stdout.write(
					latest?.focus
						? formatFocus(describeFocus(connection.doc, latest.focus))
						: `no focus: no UI client is connected to flow '${context.flow}'\n`,
				);
			} finally {
				await connection.close();
			}
			return 0;
		},
	},
	{
		name: "watch",
		args: "",
		summary: "Stream edits and focus changes as NDJSON on stdout until stopped.",
		details: `  Each line is one JSON object with type ("edit" or "focus"), origin, flow and at.
  origin is "ui" or "agent" for a tagged edit, "server" for a server repair, "mixed" for an update with both.
  Starts the server when it is not running. Exits with code 1 when the connection closes.`,
		options: {},
		positionals: [0, 0],
		async run(context) {
			const info = await ensureServer(context.root);
			const connection = await openFlow(info, context.flow);
			return watchFlow(connection, context.flow, context.io);
		},
	},
];

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

export function commandUsage(command: Command): string {
	const args = command.args ? ` ${command.args}` : "";
	const details = command.details ? `${command.details}\n` : "";
	return `Usage: flowplan ${command.name}${args} [--root <dir>] [--flow <name>]\n\n${command.summary}\n\n${details}${COMMON_HELP}\n`;
}

export function overview(): string {
	const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
	const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}${c.summary}`);
	return `Usage: flowplan <command> [options]\n\nCommands:\n${lines.join("\n")}\n\nRun flowplan <command> --help for the options of a command.\n`;
}

export function isFlowEditError(error: unknown): boolean {
	return error instanceof FlowEditError || error instanceof CliError;
}
