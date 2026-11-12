import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

type Manifest = Record<string, Record<string, string> | undefined>;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function manifests(): [string, Manifest][] {
	const paths = ["package.json", ...readdirSync(new URL("packages", root)).map((p) => `packages/${p}/package.json`)];
	return paths.map((path) => [path, JSON.parse(read(path)) as Manifest]);
}

function dependencies(): [string, string, string][] {
	return manifests().flatMap(([path, manifest]) =>
		DEPENDENCY_FIELDS.flatMap((field) =>
			Object.entries(manifest[field] ?? {}).map(([name, version]): [string, string, string] => [path, name, version]),
		),
	);
}

describe("dependency pinning", () => {
	it("gives every dependency in every package.json an exact version", () => {
		const loose = dependencies().filter(([, , version]) => !EXACT_VERSION.test(version));
		assert.deepEqual(loose, []);
		assert.ok(dependencies().length > 0);
	});

	it("resolves every dependency in the lockfile to the version that package.json names", () => {
		const lock = JSON.parse(read("package-lock.json")) as {
			packages: Record<string, { version?: string; link?: boolean; resolved?: string }>;
		};
		const lockedVersion = (name: string) => {
			const entry = lock.packages[`node_modules/${name}`];
			return entry?.link && entry.resolved ? lock.packages[entry.resolved]?.version : entry?.version;
		};
		const mismatched = dependencies().filter(([, name, version]) => lockedVersion(name) !== version);
		assert.deepEqual(mismatched, []);
	});
});

describe("lockfile", () => {
	it("is tracked by git", () => {
		assert.equal(git("ls-files", "--", "package-lock.json").trim(), "package-lock.json");
	});

	it("resolves every package from the public npm registry with an integrity hash", () => {
		const lock = JSON.parse(read("package-lock.json")) as {
			packages: Record<string, { resolved?: string; integrity?: string; link?: boolean }>;
		};
		const bad = Object.entries(lock.packages)
			.filter(([path, entry]) => path.includes("node_modules/") && !entry.link)
			.filter(
				([, entry]) =>
					!entry.resolved?.startsWith("https://registry.npmjs.org/") || !entry.integrity?.startsWith("sha512-"),
			);
		assert.deepEqual(bad, []);
	});
});

describe("project .npmrc", () => {
	const lines = read(".npmrc")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith(";"));

	it("sets the registry to public npm and the minimum release age to 7 days, and nothing else", () => {
		assert.deepEqual(lines, ["registry=https://registry.npmjs.org/", "min-release-age=7"]);
	});

	it("holds no auth setting", () => {
		assert.deepEqual(
			lines.filter((line) => /auth|token|password|username|email|cert|key/i.test(line)),
			[],
		);
	});
});

describe(".gitignore", () => {
	for (const path of ["node_modules/yjs/package.json", ".flowplan/server.json"]) {
		it(`ignores ${path}`, () => {
			assert.equal(git("check-ignore", "--no-index", path).trim(), path);
		});
	}

	it("does not ignore a flow snapshot", () => {
		assert.throws(() => git("check-ignore", "--no-index", ".flowplan/main.json"));
	});
});
