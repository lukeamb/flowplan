import { z } from "zod";

export const SCHEMA_VERSION = 1;
export const LEVELS = ["architecture", "service", "function"] as const;
export type Level = (typeof LEVELS)[number];

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SOURCE_PATTERN = /^[^\r\n]+:[1-9][0-9]*$/;

const idSchema = z.string().regex(ID_PATTERN).meta({
	description: "Stable ID. 1 to 64 characters: letters, digits, '_' or '-'. Unique across all blocks and connections.",
});

const textSchema = (max: number, description: string) => z.string().max(max).meta({ description });

export const blockSchema = z
	.strictObject({
		id: idSchema,
		level: z.enum(LEVELS).meta({ description: "Abstraction level of the block." }),
		parentId: z.union([z.string().regex(ID_PATTERN), z.null()]).meta({
			description:
				"ID of the block whose child canvas holds this block, or null for the top canvas. The parent must exist, must not be a function block, and the parent chain must not form a cycle.",
		}),
		title: textSchema(500, "Short name of the block."),
		pseudocode: textSchema(100_000, "Pseudocode that describes what the block does."),
		position: z
			.strictObject({
				x: z.number().meta({ description: "Horizontal canvas position." }),
				y: z.number().meta({ description: "Vertical canvas position." }),
			})
			.meta({ description: "Position of the block on its canvas." }),
		source: z.string().max(1024).regex(SOURCE_PATTERN).optional().meta({
			description: "Optional link to code in the form 'path:line'. Stored as text; flowplan does not read the file.",
		}),
		meta: z
			.record(z.string(), z.json())
			.optional()
			.meta({ description: "Open object for later stages. flowplan keeps every field in it unchanged." }),
	})
	.meta({ id: "block", description: "One block of the flow: a unit of work at one level." });

export const connectionSchema = z
	.strictObject({
		id: idSchema,
		from: z.string().regex(ID_PATTERN).meta({ description: "ID of the block that the data leaves." }),
		to: z.string().regex(ID_PATTERN).meta({ description: "ID of the block that the data enters." }),
		label: textSchema(500, "The data that moves along the connection."),
	})
	.meta({ id: "connection", description: "A directed connection from one block to another." });

const baseSnapshotSchema = z
	.strictObject({
		schemaVersion: z.literal(SCHEMA_VERSION).meta({ description: "Version of this snapshot format." }),
		blocks: z.array(blockSchema).meta({ description: "Every block of the flow, sorted by ID." }),
		connections: z.array(connectionSchema).meta({ description: "Every connection of the flow, sorted by ID." }),
	})
	.meta({
		title: "flowplan flow snapshot",
		description:
			"One flow, saved by flowplan as .flowplan/<flow>.json. Rules that JSON Schema cannot express: IDs are unique across blocks and connections; a parentId and a connection's from and to must name a block in the file; a function block cannot be a parent; the parent chain must not form a cycle.",
	});

export type Block = z.infer<typeof blockSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Snapshot = z.infer<typeof baseSnapshotSchema>;

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: true; snapshot: Snapshot } | { ok: false; errors: ValidationError[] };

export function buildJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(baseSnapshotSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
}

export function toJsonPath(path: readonly PropertyKey[]): string {
	let out = "$";
	for (const key of path) {
		if (typeof key === "number") out += `[${key}]`;
		else if (typeof key === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) out += `.${key}`;
		else out += `[${JSON.stringify(String(key))}]`;
	}
	return out;
}

function referenceErrors(snapshot: Snapshot): ValidationError[] {
	const errors: ValidationError[] = [];
	const seen = new Set<string>();
	const checkUnique = (id: string, path: string) => {
		if (seen.has(id)) errors.push({ path, message: `ID '${id}' is already used` });
		seen.add(id);
	};
	for (const [i, b] of snapshot.blocks.entries()) checkUnique(b.id, `$.blocks[${i}].id`);
	for (const [i, c] of snapshot.connections.entries()) checkUnique(c.id, `$.connections[${i}].id`);

	const blocks = new Map(snapshot.blocks.map((b) => [b.id, b]));
	snapshot.blocks.forEach((block, i) => {
		const path = `$.blocks[${i}].parentId`;
		if (block.parentId === null) return;
		const parent = blocks.get(block.parentId);
		if (!parent) {
			errors.push({ path, message: `parent block '${block.parentId}' does not exist` });
		} else if (parent.level === "function") {
			errors.push({
				path,
				message: `parent block '${parent.id}' is a function block, and a function block cannot be a parent`,
			});
		} else if (isInCycle(block.id, blocks)) {
			errors.push({ path, message: `block '${block.id}' is in a parent cycle` });
		}
	});

	snapshot.connections.forEach((connection, i) => {
		for (const end of ["from", "to"] as const) {
			if (!blocks.has(connection[end])) {
				errors.push({ path: `$.connections[${i}].${end}`, message: `block '${connection[end]}' does not exist` });
			}
		}
	});
	return errors;
}

function isInCycle(id: string, blocks: Map<string, { parentId: string | null }>): boolean {
	const visited = new Set<string>();
	let current = blocks.get(id)?.parentId ?? null;
	while (current !== null && !visited.has(current)) {
		if (current === id) return true;
		visited.add(current);
		current = blocks.get(current)?.parentId ?? null;
	}
	return false;
}

export function validateSnapshot(value: unknown): ValidationResult {
	const parsed = baseSnapshotSchema.safeParse(value);
	if (!parsed.success) {
		return {
			ok: false,
			errors: parsed.error.issues.map((issue) => ({ path: toJsonPath(issue.path), message: issue.message })),
		};
	}
	const errors = referenceErrors(parsed.data);
	return errors.length > 0 ? { ok: false, errors } : { ok: true, snapshot: parsed.data };
}
