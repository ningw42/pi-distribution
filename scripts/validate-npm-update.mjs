import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dependencySections = ["dependencies", "devDependencies"];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const sorted = (values) => [...values].sort();

export function validateNpmUpdate(basePackage, headPackage, lockRoot) {
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

  assert.ok(
    changed.length > 0,
    "Renovate PR must change at least one direct dependency or devDependency",
  );

  const normalizedHead = structuredClone(headPackage);
  for (const section of dependencySections) {
    normalizedHead[section] = basePackage[section];
  }
  assert.deepEqual(
    normalizedHead,
    basePackage,
    "Renovate PR changed package metadata outside dependencies and devDependencies",
  );

  for (const section of dependencySections) {
    assert.deepEqual(
      lockRoot[section],
      headPackage[section],
      `lockfile root ${section} must match package.json`,
    );
  }

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

  const basePackage = readJsonFromGit(baseSha, "package.json");
  const headPackage = readJson("package.json");
  const lockRoot = readJson("package-lock.json").packages[""];
  const changed = validateNpmUpdate(basePackage, headPackage, lockRoot);

  for (const { section, name, from, to } of changed) {
    console.log(`${section}.${name}: ${from} -> ${to}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
