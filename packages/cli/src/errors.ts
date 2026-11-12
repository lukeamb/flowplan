export class CliError extends Error {
	override name = "CliError";
}

export class UsageError extends Error {
	override name = "UsageError";
}
