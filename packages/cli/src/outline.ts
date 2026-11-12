import { type Block, printable, type Snapshot } from "@flowplan/core";

export function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function formatOutline(snapshot: Snapshot, flow: string): string {
	const children = new Map<string | null, Block[]>();
	for (const block of snapshot.blocks) {
		children.set(block.parentId, [...(children.get(block.parentId) ?? []), block]);
	}
	const lines = [
		`flow ${flow}: ${count(snapshot.blocks.length, "block")}, ${count(snapshot.connections.length, "connection")}`,
	];
	const walk = (parentId: string | null, depth: number) => {
		for (const block of children.get(parentId) ?? []) {
			const source = block.source ? ` (${printable(block.source)})` : "";
			const head = `${printable(block.id)} [${printable(block.level)}] ${printable(block.title)}`;
			lines.push(`${"  ".repeat(depth)}${head}${source}`);
			walk(block.id, depth + 1);
		}
	};
	walk(null, 0);
	if (snapshot.connections.length === 0) {
		lines.push("connections: (none)");
	} else {
		lines.push("connections:");
		for (const c of snapshot.connections) {
			const label = `"${printable(c.label.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))}"`;
			lines.push(`  ${printable(c.id)}: ${printable(c.from)} -> ${printable(c.to)} ${label}`);
		}
	}
	return `${lines.join("\n")}\n`;
}
