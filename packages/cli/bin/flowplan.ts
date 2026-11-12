#!/usr/bin/env node
process.removeAllListeners("warning");
process.on("warning", (warning) => {
	if (warning.name === "ExperimentalWarning" && warning.message.includes("localStorage")) return;
	process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2), {
	stdout: process.stdout,
	stderr: process.stderr,
	stdin: process.stdin,
});
