export type Lockfile = {
	packages: Record<string, { name?: string; version?: string; link?: boolean; [key: string]: unknown }>;
};
export type Added = { spec: string; addedAt: Date };
export type Finding = Added & { publishedAt?: Date; problem: "too young" | "no publish time" };

const DAY = 24 * 60 * 60 * 1000;

export function lockfilePackages(lock: Lockfile): string[] {
	const specs = new Set<string>();
	for (const [path, entry] of Object.entries(lock.packages)) {
		const at = path.lastIndexOf("node_modules/");
		if (at === -1 || entry.link || !entry.version) continue;
		specs.add(`${path.slice(at + "node_modules/".length)}@${entry.version}`);
	}
	return [...specs].sort();
}

export function findTooYoung(added: Added[], publishedAt: Record<string, Date>, minDays: number): Finding[] {
	const findings: Finding[] = [];
	for (const entry of added) {
		const published = publishedAt[entry.spec];
		if (!published) findings.push({ ...entry, problem: "no publish time" });
		else if (entry.addedAt.getTime() - published.getTime() < minDays * DAY) {
			findings.push({ ...entry, publishedAt: published, problem: "too young" });
		}
	}
	return findings;
}

export function splitSpec(spec: string): [name: string, version: string] {
	const at = spec.lastIndexOf("@");
	return [spec.slice(0, at), spec.slice(at + 1)];
}
