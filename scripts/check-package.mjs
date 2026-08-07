import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));
const sorted = (values) => [...values].sort();

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");

const expectedExtensions = [
  "./extensions/pi-rtk/index.ts",
  "./extensions/pi-statusline/index.ts",
  "./extensions/rpiv-ask-user-question/index.ts",
  "./extensions/pi-cc-extensions/index.ts",
  "./extensions/pi-dynamic-workflows/index.ts",
  "./extensions/pi-mcp-adapter/index.ts",
  "./extensions/pi-subagents/index.ts",
  "./extensions/pi-tasks/index.ts",
];
const expectedSkills = [
  "./node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring",
  "./node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-patterns",
  "./node_modules/pi-mcp-adapter/skills/mcp-scripting",
];
const expectedThemes = [
  "./node_modules/pi-cc-extensions/themes/github-dark-default.json",
  "./node_modules/pi-cc-extensions/themes/cc-dark.json",
];
const expectedDependencies = {
  "@quintinshaw/pi-dynamic-workflows": "3.5.1",
  "@tintinweb/pi-subagents": "0.14.3",
  "@tintinweb/pi-tasks": "0.7.2",
  "@juicesharp/rpiv-ask-user-question": "2.4.0",
  "pi-cc-extensions": "0.8.44",
  "pi-mcp-adapter": "2.21.0",
};
const expectedPeers = {
  "@earendil-works/pi-ai": "*",
  "@earendil-works/pi-coding-agent": "*",
  "@earendil-works/pi-tui": "*",
  typebox: "*",
};
const expectedShims = {
  "extensions/pi-rtk/index.ts": 'export { default } from "../../vendor/pi-rtk/index.ts";\n',
  "extensions/pi-statusline/index.ts":
    'export { default } from "../../vendor/pi-statusline/index.ts";\n',
  "extensions/rpiv-ask-user-question/index.ts":
    'export { default } from "@juicesharp/rpiv-ask-user-question";\n',
  "extensions/pi-cc-extensions/index.ts":
    'export { default } from "pi-cc-extensions/extensions/index.ts";\n',
  "extensions/pi-dynamic-workflows/index.ts":
    'export { default } from "@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts";\n',
  "extensions/pi-mcp-adapter/index.ts":
    'export { default } from "pi-mcp-adapter/index.ts";\n',
  "extensions/pi-subagents/index.ts":
    'export { default } from "@tintinweb/pi-subagents/src/index.ts";\n',
  "extensions/pi-tasks/index.ts":
    'export { default } from "@tintinweb/pi-tasks/src/index.ts";\n',
};
const dependencyTargets = {
  "node_modules/@juicesharp/rpiv-ask-user-question/index.ts": [
    "@juicesharp/rpiv-ask-user-question",
    "2.4.0",
  ],
  "node_modules/pi-cc-extensions/extensions/index.ts": ["pi-cc-extensions", "0.8.44"],
  "node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts": [
    "@quintinshaw/pi-dynamic-workflows",
    "3.5.1",
  ],
  "node_modules/pi-mcp-adapter/index.ts": ["pi-mcp-adapter", "2.21.0"],
  "node_modules/@tintinweb/pi-subagents/src/index.ts": ["@tintinweb/pi-subagents", "0.14.3"],
  "node_modules/@tintinweb/pi-tasks/src/index.ts": ["@tintinweb/pi-tasks", "0.7.2"],
};

assert.equal(pkg.private, true, "the package must remain private until publication is intentional");
assert.equal(pkg.license, "UNLICENSED");
assert.deepEqual(pkg.pi, {
  extensions: expectedExtensions,
  skills: expectedSkills,
  themes: expectedThemes,
});
for (const [resourceType, expectedPaths] of Object.entries(pkg.pi)) {
  assert.equal(
    new Set(expectedPaths).size,
    expectedPaths.length,
    `pi.${resourceType} paths must be unique`,
  );
  for (const path of expectedPaths) {
    assert.equal(existsSync(join(root, path)), true, `missing pi.${resourceType} resource: ${path}`);
  }
}

assert.deepEqual(pkg.dependencies, expectedDependencies);
assert.deepEqual(sorted(pkg.bundledDependencies), sorted(Object.keys(expectedDependencies)));
assert.deepEqual(pkg.peerDependencies, expectedPeers);
for (const peer of Object.keys(expectedPeers)) {
  assert.deepEqual(pkg.peerDependenciesMeta?.[peer], { optional: true });
  assert.equal(Object.hasOwn(pkg.dependencies, peer), false, `${peer} must not be a direct dependency`);
  assert.equal(pkg.bundledDependencies.includes(peer), false, `${peer} must not be explicitly bundled`);
}
assert.equal(Object.hasOwn(pkg.dependencies, "pi-subagents"), false);
assert.equal(Object.hasOwn(pkg.dependencies, "pi-tasks"), false);

for (const [path, expected] of Object.entries(expectedShims)) {
  assert.equal(readText(path), expected, `${path} must remain a forwarding-only shim`);
}
for (const dependency of [
  "@juicesharp/rpiv-ask-user-question",
  "@quintinshaw/pi-dynamic-workflows",
]) {
  assert.equal(
    existsSync(join(root, `vendor/${dependency}`)),
    false,
    `${dependency} must remain a dependency, not vendored source`,
  );
}

for (const [entryPath, [name, version]] of Object.entries(dependencyTargets)) {
  assert.equal(existsSync(join(root, entryPath)), true, `missing dependency entry point: ${entryPath}`);
  const packagePath = entryPath.slice(0, entryPath.indexOf(name) + name.length) + "/package.json";
  const dependencyPackage = readJson(packagePath);
  assert.equal(dependencyPackage.name, name);
  assert.equal(dependencyPackage.version, version);
}

assert.equal(lock.lockfileVersion, 3);
assert.deepEqual(lock.packages[""].dependencies, expectedDependencies);
assert.deepEqual(sorted(lock.packages[""].bundleDependencies), sorted(Object.keys(expectedDependencies)));
const askLock = lock.packages["node_modules/@juicesharp/rpiv-ask-user-question"];
assert.equal(askLock.version, "2.4.0");
assert.equal(
  askLock.resolved,
  "https://registry.npmjs.org/@juicesharp/rpiv-ask-user-question/-/rpiv-ask-user-question-2.4.0.tgz",
);
assert.match(askLock.integrity, /^sha512-/);

const rtk = readText("vendor/pi-rtk/index.ts");
assert.equal(
  createHash("sha256").update(rtk).digest("hex"),
  "d278508809a5379e506384eabb19e17a672806c4eac7eabc1cd634699aea8c33",
  "the RTK source must match the canonical RTK 0.44.2-generated extension",
);
assert.equal(existsSync(join(root, "vendor/pi-rtk/LICENSE")), true);

const statusline = readText("vendor/pi-statusline/index.ts");
assert.equal(statusline.includes("@starshipBin@"), false, "the statusline must not retain Nix placeholders");
assert.match(
  statusline,
  /const STARSHIP_BIN = process\.env\.PI_STATUSLINE_STARSHIP \|\| "starship";/,
);

console.log(
  "package checks passed: 8 extensions, 3 skills, 2 themes, 6 pinned dependencies, 2 local implementations",
);
