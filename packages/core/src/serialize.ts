import { type Snapshot, type ValidationResult, validateSnapshot } from "./schema.ts";

export function compareIds(a: { id: string }, b: { id: string }): number {
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

export function serializeSnapshot(snapshot: Snapshot): string {
	const canonical = {
		...snapshot,
		blocks: [...snapshot.blocks].sort(compareIds),
		connections: [...snapshot.connections].sort(compareIds),
	};
	return `${JSON.stringify(sortKeys(canonical), null, 2)}\n`;
}

export function parseSnapshot(text: string): ValidationResult {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, errors: [{ path: "$", message: `not valid JSON: ${(error as Error).message}` }] };
	}
	return validateSnapshot(value);
}
