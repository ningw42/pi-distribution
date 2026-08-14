import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dependencySections = ["dependencies", "devDependencies"];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const sorted = (values) => [...values].sort();

export function validateNpmUpdate(
  basePackage,
  headPackage,
  lockRoot,
  { requireChange = true } = {},
) {
  const changed = [];

  for (const section of dependencySections) {
    const baseDependencies = basePackage[section] ?? {};
    const headDependencies = headPackage[section] ?? {};

    assert.deepEqual(
      sorted(Object.keys(headDependencies)),
      sorted(Object.keys(baseDependencies)),
      `Renovate PR must not change ${section} names`,
    );

    for (const [name, version] of Object.entries(headDependencies)) {
      assert.match(version, exactVersion, `${name} must remain exactly pinned`);
      if (version !== baseDependencies[name]) {
        changed.push({ section, name, from: baseDependencies[name], to: version });
      }
    }
  }

  if (requireChange) {
    assert.ok(
      changed.length > 0,
      "Renovate PR must change at least one direct dependency or devDependency",
    );
  }

  const normalizedHead = structuredClone(headPackage);
  for (const section of dependencySections) {
    if (Object.hasOwn(basePackage, section)) {
      normalizedHead[section] = basePackage[section];
    } else {
      delete normalizedHead[section];
    }
  }
  assert.deepEqual(
    normalizedHead,
    basePackage,
    "Renovate PR changed package metadata outside dependencies and devDependencies",
  );

  for (const section of dependencySections) {
    assert.deepEqual(
      lockRoot[section] ?? {},
      headPackage[section] ?? {},
      `lockfile root ${section} must match package.json`,
    );
  }

  return changed;
}

export function validateNpmUpdates(targets) {
  const changed = targets.flatMap(({ path, basePackage, headPackage, lockRoot }) =>
    validateNpmUpdate(basePackage, headPackage, lockRoot, { requireChange: false }).map(
      (change) => ({ path, ...change }),
    ),
  );

  assert.ok(
    changed.length > 0,
    "Renovate PR must change at least one direct dependency or devDependency",
  );
  return changed;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonFromGit(sha, path) {
  return JSON.parse(
    execFileSync("git", ["show", `${sha}:${path}`], {
      encoding: "utf8",
    }),
  );
}

function main() {
  const baseSha = process.argv[2];
  assert.ok(baseSha, "usage: node scripts/validate-npm-update.mjs <base-sha>");

  const packagePairs = [
    ["package.json", "package-lock.json"],
    ["tests/smoke-runtime/package.json", "tests/smoke-runtime/package-lock.json"],
  ];
  const targets = packagePairs.map(([packagePath, lockPath]) => ({
    path: packagePath,
    basePackage: readJsonFromGit(baseSha, packagePath),
    headPackage: readJson(packagePath),
    lockRoot: readJson(lockPath).packages[""],
  }));
  const changed = validateNpmUpdates(targets);

  for (const { path, section, name, from, to } of changed) {
    console.log(`${path}:${section}.${name}: ${from} -> ${to}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
