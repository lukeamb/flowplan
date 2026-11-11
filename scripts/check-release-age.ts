import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Added, findTooYoung, type Lockfile, lockfilePackages, splitSpec } from "./release-age.ts";

const MIN_DAYS = 7;
const REGISTRY = "https://registry.npmjs.org/";
const LOCKFILE = "package-lock.json";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });

function addedVersions(): Added[] {
	const added = new Map<string, Date>();
	const history = git("log", "--reverse", "--format=%H %cI", "--", LOCKFILE).trim();
	for (const line of history ? history.split("\n") : []) {
		const [hash, date] = line.split(" ");
		const lock = JSON.parse(git("show", `${hash}:${LOCKFILE}`)) as Lockfile;
		for (const spec of lockfilePackages(lock)) if (!added.has(spec)) added.set(spec, new Date(date as string));
	}
	const now = new Date();
	const current = lockfilePackages(JSON.parse(readFileSync(LOCKFILE, "utf8")) as Lockfile);
	return current.map((spec) => ({ spec, addedAt: added.get(spec) ?? now }));
}

async function publishTimes(specs: string[]): Promise<Record<string, Date>> {
	const names = [...new Set(specs.map((spec) => splitSpec(spec)[0]))];
	const times: Record<string, Date> = {};
	await Promise.all(
		names.map(async (name) => {
			const response = await fetch(`${REGISTRY}${name.replace("/", "%2f")}`);
			if (!response.ok) throw new Error(`${name}: registry answered ${response.status}`);
			const body = (await response.json()) as { time?: Record<string, string> };
			for (const [version, time] of Object.entries(body.time ?? {})) times[`${name}@${version}`] = new Date(time);
		}),
	);
	return times;
}

const added = addedVersions();
const findings = findTooYoung(added, await publishTimes(added.map((a) => a.spec)), MIN_DAYS);
for (const f of findings) {
	console.error(
		`FAIL ${f.spec}: ${f.problem}; published ${f.publishedAt?.toISOString() ?? "?"}, added ${f.addedAt.toISOString()}`,
	);
}
console.log(
	`${added.length} locked versions checked; ${findings.length} published less than ${MIN_DAYS} days before the commit that adds them`,
);
process.exitCode = findings.length > 0 ? 1 : 0;
