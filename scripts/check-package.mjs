import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));
const sorted = (values) => [...values].sort();

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const smokeRuntimePackage = readJson("tests/smoke-runtime/package.json");
const smokeRuntimeLock = readJson("tests/smoke-runtime/package-lock.json");

assert.equal(
  readText(".gitattributes"),
  "* text=auto eol=lf\n",
  "the repository must preserve LF package sources on Windows checkouts",
);

const expectedExtensions = [
  "./extensions/pi-rtk/index.ts",
  "./extensions/pi-statusline/index.ts",
  "./extensions/pi-status/index.ts",
  "./extensions/rpiv-ask-user-question/index.ts",
  "./extensions/pi-cc-extensions/index.ts",
  "./extensions/pi-dynamic-workflows/index.ts",
  "./extensions/pi-mcp-adapter/index.ts",
  "./extensions/pi-theme-picker/index.ts",
  "./extensions/pi-subagents/index.ts",
  "./extensions/pi-tasks/index.ts",
];
const expectedSkills = [
  "./node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring",
  "./node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-patterns",
  "./node_modules/pi-mcp-adapter/skills/mcp-scripting",
];
const catppuccinThemeDirectory = "./node_modules/@sherif-fanous/pi-catppuccin/themes";
const expectedCatppuccinThemeNames = [
  "catppuccin-frappe",
  "catppuccin-latte",
  "catppuccin-macchiato",
  "catppuccin-mocha",
];
const expectedThemes = [
  "./node_modules/pi-cc-extensions/themes",
  catppuccinThemeDirectory,
];
const expectedDependencyNames = [
  "@juicesharp/rpiv-ask-user-question",
  "@quintinshaw/pi-dynamic-workflows",
  "@sherif-fanous/pi-catppuccin",
  "@thinkscape/pi-status",
  "@tintinweb/pi-subagents",
  "@tintinweb/pi-tasks",
  "pi-cc-extensions",
  "pi-mcp-adapter",
  "pi-theme-picker",
];
const smokePiName = "@earendil-works/pi-coding-agent";
const expectedRootDevDependencyNames = [];
const expectedPeers = {
  "@earendil-works/pi-ai": "*",
  "@earendil-works/pi-coding-agent": "*",
  "@earendil-works/pi-tui": "*",
  typebox: "*",
};
const shimTargets = {
  "extensions/pi-rtk/index.ts": "vendor/pi-rtk/index.ts",
  "extensions/pi-statusline/index.ts": "vendor/pi-statusline/index.ts",
  "extensions/pi-status/index.ts": "node_modules/@thinkscape/pi-status/src/index.ts",
  "extensions/rpiv-ask-user-question/index.ts":
    "node_modules/@juicesharp/rpiv-ask-user-question/index.ts",
  "extensions/pi-cc-extensions/index.ts": "node_modules/pi-cc-extensions/extensions/index.ts",
  "extensions/pi-dynamic-workflows/index.ts":
    "node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts",
  "extensions/pi-mcp-adapter/index.ts": "node_modules/pi-mcp-adapter/index.ts",
  "extensions/pi-theme-picker/index.ts": "node_modules/pi-theme-picker/index.ts",
  "extensions/pi-subagents/index.ts": "node_modules/@tintinweb/pi-subagents/src/index.ts",
  "extensions/pi-tasks/index.ts": "node_modules/@tintinweb/pi-tasks/src/index.ts",
};
const dependencyTargets = {
  "node_modules/@juicesharp/rpiv-ask-user-question/index.ts":
    "@juicesharp/rpiv-ask-user-question",
  "node_modules/pi-cc-extensions/extensions/index.ts": "pi-cc-extensions",
  "node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts":
    "@quintinshaw/pi-dynamic-workflows",
  "node_modules/pi-mcp-adapter/index.ts": "pi-mcp-adapter",
  "node_modules/@thinkscape/pi-status/src/index.ts": "@thinkscape/pi-status",
  "node_modules/pi-theme-picker/index.ts": "pi-theme-picker",
  "node_modules/@tintinweb/pi-subagents/src/index.ts": "@tintinweb/pi-subagents",
  "node_modules/@tintinweb/pi-tasks/src/index.ts": "@tintinweb/pi-tasks",
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

const themeFiles = expectedThemes
  .flatMap((themeDirectory) => {
    const files = readdirSync(join(root, themeDirectory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => `${themeDirectory}/${entry.name}`);
    assert.ok(files.length > 0, `${themeDirectory} must contain at least one JSON theme`);
    return files;
  })
  .sort();
const themes = themeFiles.map((path) => {
  const theme = readJson(path);
  assert.equal(typeof theme.name, "string", `${path} must declare a string theme name`);
  assert.notEqual(theme.name.trim(), "", `${path} must declare a non-empty theme name`);
  return { path, name: theme.name };
});
const themeNames = themes.map(({ name }) => name);
assert.equal(
  new Set(themeNames).size,
  themeNames.length,
  "theme names must be unique across all exposed collections",
);
assert.deepEqual(
  sorted(
    themes
      .filter(({ path }) => path.startsWith(`${catppuccinThemeDirectory}/`))
      .map(({ name }) => name),
  ),
  expectedCatppuccinThemeNames,
  "the Catppuccin collection must expose all four flavors",
);

assert.deepEqual(sorted(Object.keys(pkg.dependencies)), sorted(expectedDependencyNames));
for (const [name, version] of Object.entries(pkg.dependencies)) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must use an exact version`);
}
assert.deepEqual(sorted(pkg.bundleDependencies), sorted(expectedDependencyNames));
assert.deepEqual(
  sorted(Object.keys(pkg.devDependencies ?? {})),
  expectedRootDevDependencyNames,
  "the production package must not carry test-only dependencies",
);
assert.deepEqual(pkg.peerDependencies, expectedPeers);
for (const peer of Object.keys(expectedPeers)) {
  assert.deepEqual(pkg.peerDependenciesMeta?.[peer], { optional: true });
  assert.equal(Object.hasOwn(pkg.dependencies, peer), false, `${peer} must not be a direct dependency`);
  assert.equal(pkg.bundleDependencies.includes(peer), false, `${peer} must not be explicitly bundled`);
}
assert.equal(Object.hasOwn(pkg.dependencies, "pi-subagents"), false);
assert.equal(Object.hasOwn(pkg.dependencies, "pi-tasks"), false);

for (const [path, target] of Object.entries(shimTargets)) {
  const expected = `export { default } from "../../${target}";\n`;
  assert.equal(readText(path), expected, `${path} must forward to the exact bundled entry file`);
}
for (const dependency of [
  "@juicesharp/rpiv-ask-user-question",
  "@quintinshaw/pi-dynamic-workflows",
  "@sherif-fanous/pi-catppuccin",
  "@thinkscape/pi-status",
  "pi-theme-picker",
]) {
  assert.equal(
    existsSync(join(root, `vendor/${dependency}`)),
    false,
    `${dependency} must remain a dependency, not vendored source`,
  );
}

for (const [entryPath, name] of Object.entries(dependencyTargets)) {
  assert.equal(existsSync(join(root, entryPath)), true, `missing dependency entry point: ${entryPath}`);
  const packagePath = entryPath.slice(0, entryPath.indexOf(name) + name.length) + "/package.json";
  const dependencyPackage = readJson(packagePath);
  assert.equal(dependencyPackage.name, name);
  assert.equal(dependencyPackage.version, pkg.dependencies[name]);
}
const catppuccinName = "@sherif-fanous/pi-catppuccin";
const catppuccinPackage = readJson(`node_modules/${catppuccinName}/package.json`);
assert.equal(catppuccinPackage.name, catppuccinName);
assert.equal(catppuccinPackage.version, pkg.dependencies[catppuccinName]);
assert.equal(catppuccinPackage.license, "MIT");
assert.deepEqual(catppuccinPackage.pi, { themes: ["./themes"] });

assert.equal(lock.lockfileVersion, 3);
assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
assert.deepEqual(lock.packages[""].devDependencies ?? {}, pkg.devDependencies ?? {});
assert.deepEqual(sorted(lock.packages[""].bundleDependencies), sorted(expectedDependencyNames));
assert.equal(
  Object.hasOwn(lock.packages, `node_modules/${smokePiName}`),
  false,
  "the production lock must not include the smoke-test Pi runtime",
);
for (const [path, entry] of Object.entries(lock.packages)) {
  if (entry.resolved?.startsWith("https://registry.npmjs.org/")) {
    assert.match(entry.integrity, /^sha512-/, `${path} must declare registry integrity`);
  }
}

assert.equal(smokeRuntimePackage.private, true);
assert.deepEqual(smokeRuntimePackage.dependencies ?? {}, {});
assert.deepEqual(Object.keys(smokeRuntimePackage.devDependencies ?? {}), [smokePiName]);
assert.match(
  smokeRuntimePackage.devDependencies[smokePiName],
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  `${smokePiName} must use an exact smoke-test version`,
);
assert.equal(smokeRuntimeLock.lockfileVersion, 3);
assert.deepEqual(
  smokeRuntimeLock.packages[""].devDependencies,
  smokeRuntimePackage.devDependencies,
);
const smokePiLock = smokeRuntimeLock.packages[`node_modules/${smokePiName}`];
assert.equal(smokePiLock.version, smokeRuntimePackage.devDependencies[smokePiName]);
assert.equal(smokePiLock.dev, true);
assert.match(smokePiLock.integrity, /^sha512-/);
const askName = "@juicesharp/rpiv-ask-user-question";
const askVersion = pkg.dependencies[askName];
const askLock = lock.packages[`node_modules/${askName}`];
assert.equal(askLock.version, askVersion);
assert.equal(
  askLock.resolved,
  `https://registry.npmjs.org/${askName}/-/rpiv-ask-user-question-${askVersion}.tgz`,
);
assert.match(askLock.integrity, /^sha512-/);
const themePickerName = "pi-theme-picker";
const themePickerVersion = pkg.dependencies[themePickerName];
const themePickerLock = lock.packages[`node_modules/${themePickerName}`];
assert.equal(themePickerLock.version, themePickerVersion);
assert.equal(
  themePickerLock.resolved,
  `https://registry.npmjs.org/${themePickerName}/-/pi-theme-picker-${themePickerVersion}.tgz`,
);
assert.match(themePickerLock.integrity, /^sha512-/);

const rtkMetadata = readJson("vendor/pi-rtk/metadata.json");
assert.equal(rtkMetadata.schemaVersion, 1);
assert.equal(rtkMetadata.upstreamRepository, "rtk-ai/rtk");
assert.match(rtkMetadata.version, /^\d+\.\d+\.\d+$/);
assert.equal(rtkMetadata.tag, `v${rtkMetadata.version}`);
assert.match(rtkMetadata.commit, /^[0-9a-f]{40}$/);
assert.equal(rtkMetadata.generatorCommand, "rtk init -g --agent pi --no-patch");
assert.equal(rtkMetadata.upstreamSourcePath, "hooks/pi/rtk.ts");
assert.match(rtkMetadata.generatedSourceSha256, /^[0-9a-f]{64}$/);
assert.match(rtkMetadata.licenseSha256, /^[0-9a-f]{64}$/);
assert.equal(
  createHash("sha256").update(readText("vendor/pi-rtk/index.ts")).digest("hex"),
  rtkMetadata.generatedSourceSha256,
  `the pi-rtk source must match the recorded RTK ${rtkMetadata.version} artifact`,
);
assert.equal(
  createHash("sha256").update(readText("vendor/pi-rtk/LICENSE")).digest("hex"),
  rtkMetadata.licenseSha256,
  `the pi-rtk license must match the recorded RTK ${rtkMetadata.version} artifact`,
);

const statusline = readText("vendor/pi-statusline/index.ts");
assert.equal(statusline.includes("@starshipBin@"), false, "the statusline must not retain Nix placeholders");
assert.match(
  statusline,
  /const STARSHIP_BIN = process\.env\.PI_STATUSLINE_STARSHIP \|\| "starship";/,
);

console.log(
  `package checks passed: 10 extensions, 3 skills, ${themeFiles.length} themes, ${expectedDependencyNames.length} pinned dependencies, 1 pinned smoke runtime, 2 local implementations`,
);
