import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { docToSnapshot, parseSnapshot, serializeSnapshot, snapshotToDoc, validateSnapshot } from "@flowplan/core";
import * as Y from "yjs";

export const FLOW_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const RESERVED_NAMES = new Set(["server"]);

export function isFlowName(name: string): boolean {
	return FLOW_NAME.test(name) && !RESERVED_NAMES.has(name);
}

export type FlowStoreOptions = {
	dir: string;
	debounceMs: number;
	log: (line: string) => void;
	onSnapshotWrite?: ((flow: string) => void) | undefined;
};

type Flow = { doc: Y.Doc; timer?: NodeJS.Timeout | undefined; lastWritten?: string; writing: Promise<void> };

export class FlowStore {
	private readonly flows = new Map<string, Flow>();
	private readonly failed = new Set<string>();
	private writeCounter = 0;

	private readonly options: FlowStoreOptions;

	constructor(options: FlowStoreOptions) {
		this.options = options;
	}

	async load(): Promise<void> {
		await mkdir(this.options.dir, { recursive: true });
		for (const file of (await readdir(this.options.dir)).sort()) {
			if (!file.endsWith(".json") || file.startsWith(".")) continue;
			const name = file.slice(0, -".json".length);
			if (RESERVED_NAMES.has(name)) continue;
			if (!FLOW_NAME.test(name)) {
				this.options.log(`flow file '${file}' skipped: the name is not a valid flow name`);
				continue;
			}
			const result = parseSnapshot(await readFile(join(this.options.dir, file), "utf8"));
			if (!result.ok) {
				this.failed.add(name);
				for (const error of result.errors) {
					this.options.log(`flow '${name}' not loaded: snapshot is not valid: ${error.path}: ${error.message}`);
				}
				continue;
			}
			this.add(name, snapshotToDoc(result.snapshot), serializeSnapshot(result.snapshot));
		}
	}

	names(): string[] {
		return [...this.flows.keys()].sort();
	}

	get(name: string): Y.Doc | undefined {
		return this.flows.get(name)?.doc;
	}

	hasFailed(name: string): boolean {
		return this.failed.has(name);
	}

	open(name: string): Y.Doc {
		const existing = this.flows.get(name);
		if (existing) return existing.doc;
		return this.add(name, new Y.Doc());
	}

	private add(name: string, doc: Y.Doc, lastWritten?: string): Y.Doc {
		const flow: Flow = { doc, writing: Promise.resolve() };
		if (lastWritten !== undefined) flow.lastWritten = lastWritten;
		this.flows.set(name, flow);
		doc.on("update", () => this.schedule(name, flow));
		return doc;
	}

	private schedule(name: string, flow: Flow): void {
		clearTimeout(flow.timer);
		flow.timer = setTimeout(() => {
			flow.timer = undefined;
			flow.writing = flow.writing.then(() => this.write(name, flow));
		}, this.options.debounceMs);
	}

	private async write(name: string, flow: Flow): Promise<void> {
		try {
			const result = validateSnapshot(docToSnapshot(flow.doc));
			if (!result.ok) {
				for (const error of result.errors) {
					this.options.log(
						`flow '${name}': snapshot is not valid, kept the last valid file: ${error.path}: ${error.message}`,
					);
				}
				return;
			}
			const text = serializeSnapshot(result.snapshot);
			if (text === flow.lastWritten) return;
			const target = join(this.options.dir, `${name}.json`);
			const temp = join(this.options.dir, `.${name}.json.${process.pid}.${++this.writeCounter}.tmp`);
			try {
				await writeFile(temp, text, { flag: "wx" });
				await rename(temp, target);
			} catch (error) {
				await rm(temp, { force: true });
				throw error;
			}
			flow.lastWritten = text;
			this.options.onSnapshotWrite?.(name);
		} catch (error) {
			this.options.log(`flow '${name}': snapshot not written, kept the last valid file: ${(error as Error).message}`);
		}
	}

	async flush(): Promise<void> {
		for (const [name, flow] of this.flows) {
			if (flow.timer) {
				clearTimeout(flow.timer);
				flow.timer = undefined;
				flow.writing = flow.writing.then(() => this.write(name, flow));
			}
		}
		await Promise.all([...this.flows.values()].map((flow) => flow.writing));
	}
}
