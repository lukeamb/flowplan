import type * as Y from "yjs";
import { z } from "zod";
import { blocksOf, textOf } from "./doc.ts";
import { ORIGINS, type Origin } from "./edits.ts";
import { ID_PATTERN } from "./schema.ts";

export const PRESENCE_KEY = "flowplan";

const idList = z.array(z.string().regex(ID_PATTERN)).max(1000);

const presenceSchema = z.strictObject({
	kind: z.enum(ORIGINS),
	focus: z.strictObject({ canvas: idList, selected: idList }).optional(),
});

export type Focus = { canvas: string[]; selected: string[] };
export type Presence = { kind: Origin; focus?: Focus };
export type FocusItem = { id: string; title: string | null };
export type FocusView = { canvas: FocusItem[]; selected: FocusItem[] };

export function presenceState(presence: Presence): Record<string, unknown> {
	return { [PRESENCE_KEY]: presence };
}

export function parsePresence(state: unknown): Presence | undefined {
	if (state === null || typeof state !== "object") return undefined;
	const parsed = presenceSchema.safeParse((state as Record<string, unknown>)[PRESENCE_KEY]);
	if (!parsed.success) return undefined;
	const { kind, focus } = parsed.data;
	return focus ? { kind, focus } : { kind };
}

export function describeFocus(doc: Y.Doc, focus: Focus): FocusView {
	const blocks = blocksOf(doc);
	const item = (id: string): FocusItem => {
		const block = blocks.get(id);
		return { id, title: block ? textOf(block, "title") : null };
	};
	return { canvas: focus.canvas.map(item), selected: focus.selected.map(item) };
}

export function formatFocus(view: FocusView): string {
	const name = (item: FocusItem) => item.title ?? `(deleted ${item.id})`;
	const canvas = ["Top", ...view.canvas.map(name)].join(" › ");
	const selected =
		view.selected.length === 0 ? "(none)" : view.selected.map((item) => `${name(item)} (${item.id})`).join(", ");
	return `canvas: ${canvas}\nselected: ${selected}\n`;
}
