import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findTooYoung, lockfilePackages } from "../scripts/release-age.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("lockfilePackages", () => {
	it("lists each installed name and version, including nested and optional packages, and skips links", () => {
		const lock = {
			packages: {
				"": { name: "root" },
				"node_modules/yjs": { version: "13.6.33" },
				"node_modules/@biomejs/cli-linux-x64": { version: "2.6.4", optional: true },
				"node_modules/a/node_modules/lib0": { version: "0.2.100" },
				"node_modules/@flowplan/core": { resolved: "packages/core", link: true },
				"packages/core": { version: "0.0.0" },
			},
		};
		assert.deepEqual(lockfilePackages(lock), ["@biomejs/cli-linux-x64@2.6.4", "lib0@0.2.100", "yjs@13.6.33"]);
	});
});

describe("findTooYoung", () => {
	const commit = new Date("2026-11-11T12:00:00Z");

	it("passes a version published 7 days or more before the commit that adds it", () => {
		const result = findTooYoung(
			[{ spec: "a@1.0.0", addedAt: commit }],
			{ "a@1.0.0": new Date(commit.getTime() - 7 * DAY) },
			7,
		);
		assert.deepEqual(result, []);
	});

	it("fails a version published less than 7 days before the commit that adds it", () => {
		const published = new Date(commit.getTime() - 7 * DAY + 1000);
		const result = findTooYoung([{ spec: "a@1.0.0", addedAt: commit }], { "a@1.0.0": published }, 7);
		assert.deepEqual(result, [{ spec: "a@1.0.0", addedAt: commit, publishedAt: published, problem: "too young" }]);
	});

	it("fails a version with no publish time", () => {
		const result = findTooYoung([{ spec: "a@1.0.0", addedAt: commit }], {}, 7);
		assert.equal(result[0]?.problem, "no publish time");
	});
});
