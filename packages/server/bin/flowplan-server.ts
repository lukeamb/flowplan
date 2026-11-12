#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startServer } from "../src/index.ts";

const usage = `Usage: flowplan-server [--root <dir>] [--port <n>] [--allow-origin <url>]...

Starts the flowplan server for the flows in <dir>/.flowplan (default: the current directory).
  --root <dir>          Directory that holds .flowplan/.
  --port <n>            Port on 127.0.0.1. Default: 0, a free port.
  --allow-origin <url>  Also accept browser websockets from this origin. Repeat for more.
  --help                Print this help.`;

let values: { root?: string; port?: string; "allow-origin"?: string[]; help?: boolean };
try {
	({ values } = parseArgs({
		options: {
			root: { type: "string" },
			port: { type: "string" },
			"allow-origin": { type: "string", multiple: true },
			help: { type: "boolean" },
		},
		strict: true,
		allowPositionals: false,
	}));
} catch (error) {
	console.error(`${(error as Error).message}\n\n${usage}`);
	process.exit(2);
}

if (values.help) {
	console.log(usage);
	process.exit(0);
}

const port = values.port === undefined ? 0 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	console.error(`--port must be a whole number from 0 to 65535\n\n${usage}`);
	process.exit(2);
}

try {
	const server = await startServer({
		root: values.root ?? process.cwd(),
		port,
		allowedOrigins: values["allow-origin"] ?? [],
	});
	console.log(`flowplan server: http://127.0.0.1:${server.port} (flows in ${server.dir})`);
	const stop = () => {
		server.close().then(
			() => process.exit(0),
			(error: Error) => {
				console.error(`flowplan server did not stop cleanly: ${error.message}`);
				process.exit(1);
			},
		);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
} catch (error) {
	console.error(`flowplan server did not start: ${(error as Error).message}`);
	process.exit(1);
}
