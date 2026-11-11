import type { Snapshot } from "../src/index.ts";

export function sampleSnapshot(): Snapshot {
	return {
		schemaVersion: 1,
		blocks: [
			{
				id: "b_api",
				level: "service",
				parentId: "b_root",
				title: "API service",
				pseudocode: "receive request\nvalidate token",
				position: { x: 120, y: 40.5 },
				source: "src/api/server.ts:12",
			},
			{
				id: "b_login",
				level: "function",
				parentId: "b_api",
				title: "login()",
				pseudocode: "look up user\ncompare hash",
				position: { x: 0, y: 0 },
				meta: { review: { tick: true }, tags: ["auth", 2], zeta: null },
			},
			{
				id: "b_root",
				level: "architecture",
				parentId: null,
				title: "Auth",
				pseudocode: "",
				position: { x: -10, y: 300 },
			},
			{
				id: "b_store",
				level: "service",
				parentId: "b_root",
				title: "User store",
				pseudocode: "SELECT user",
				position: { x: 400, y: 40 },
			},
		],
		connections: [{ id: "c_api_store", from: "b_api", to: "b_store", label: "user id" }],
	};
}
