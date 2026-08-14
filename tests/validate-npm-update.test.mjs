import assert from "node:assert/strict";
import test from "node:test";

import { validateNpmUpdate } from "../scripts/validate-npm-update.mjs";

const basePackage = {
  name: "fixture",
  version: "1.0.0",
  scripts: { test: "node --test" },
  dependencies: {
    runtime: "1.0.0",
  },
  devDependencies: {
    development: "2.0.0",
  },
};

function updatedPackage({ runtime = "1.0.0", development = "2.0.0" } = {}) {
  return {
    ...structuredClone(basePackage),
    dependencies: { runtime },
    devDependencies: { development },
  };
}

function matchingLock(headPackage) {
  return {
    dependencies: structuredClone(headPackage.dependencies),
    devDependencies: structuredClone(headPackage.devDependencies),
  };
}

test("accepts exact updates to dependencies and devDependencies", () => {
  const headPackage = updatedPackage({ runtime: "1.1.0", development: "2.1.0" });

  assert.deepEqual(
    validateNpmUpdate(basePackage, headPackage, matchingLock(headPackage)),
    [
      { section: "dependencies", name: "runtime", from: "1.0.0", to: "1.1.0" },
      {
        section: "devDependencies",
        name: "development",
        from: "2.0.0",
        to: "2.1.0",
      },
    ],
  );
});

test("accepts a devDependency-only update", () => {
  const headPackage = updatedPackage({ development: "2.1.0" });

  assert.deepEqual(validateNpmUpdate(basePackage, headPackage, matchingLock(headPackage)), [
    {
      section: "devDependencies",
      name: "development",
      from: "2.0.0",
      to: "2.1.0",
    },
  ]);
});

test("rejects package metadata changes outside dependency sections", () => {
  const headPackage = {
    ...updatedPackage({ runtime: "1.1.0" }),
    version: "2.0.0",
  };

  assert.throws(
    () => validateNpmUpdate(basePackage, headPackage, matchingLock(headPackage)),
    /outside dependencies and devDependencies/,
  );
});

test("rejects non-exact devDependency versions", () => {
  const headPackage = updatedPackage({ development: "^2.1.0" });

  assert.throws(
    () => validateNpmUpdate(basePackage, headPackage, matchingLock(headPackage)),
    /development must remain exactly pinned/,
  );
});

test("rejects a stale root devDependencies lock entry", () => {
  const headPackage = updatedPackage({ development: "2.1.0" });
  const lockRoot = matchingLock(headPackage);
  lockRoot.devDependencies.development = "2.0.0";

  assert.throws(
    () => validateNpmUpdate(basePackage, headPackage, lockRoot),
    /lockfile root devDependencies must match package.json/,
  );
});
