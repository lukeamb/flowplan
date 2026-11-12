import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isFlowName } from "@flowplan/server";
import {
	COMMANDS,
	COMMON_OPTIONS,
	type Command,
	commandUsage,
	type Io,
	isFlowEditError,
	overview,
} from "./commands.ts";
import { UsageError } from "./errors.ts";

export async function main(argv: string[], io: Io): Promise<number> {
	const [name, ...rest] = argv;
	if (name === "--help" || name === "help") {
		io.stdout.write(overview());
		return 0;
	}
	if (name === undefined) {
		io.stderr.write(overview());
		return 2;
	}
	const command = COMMANDS.find((c) => c.name === name);
	if (!command) {
		io.stderr.write(`flowplan: unknown command '${name}'\n\n${overview()}`);
		return 2;
	}
	try {
		const { values, positionals } = parseArgs({
			args: rest,
			options: { ...COMMON_OPTIONS, ...command.options },
			allowPositionals: true,
			strict: true,
		});
		if (values.help) {
			io.stdout.write(commandUsage(command));
			return 0;
		}
		checkPositionals(command, positionals.length);
		const flow = typeof values.flow === "string" ? values.flow : "main";
		if (!isFlowName(flow)) throw new UsageError(`'${flow}' is not a valid flow name`);
		const root = resolve(typeof values.root === "string" ? values.root : process.cwd());
		return await command.run({ values, positionals, root, flow, io });
	} catch (error) {
		if (error instanceof UsageError || (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
			io.stderr.write(`flowplan ${name}: ${(error as Error).message}\n\n${commandUsage(command)}`);
			return 2;
		}
		if (isFlowEditError(error)) {
			io.stderr.write(`flowplan ${name}: ${(error as Error).message}\n`);
			return 1;
		}
		io.stderr.write(`flowplan ${name}: unexpected error: ${(error as Error).stack ?? error}\n`);
		return 1;
	}
}

function checkPositionals(command: Command, given: number): void {
	const [min, max] = command.positionals;
	if (given < min || given > max) {
		const expected = min === max ? `${min}` : `${min} to ${max}`;
		throw new UsageError(`expected ${expected} argument${max === 1 ? "" : "s"}, got ${given}`);
	}
}
