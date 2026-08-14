import assert from "node:assert/strict";
import test from "node:test";

import {
  validateNpmUpdate,
  validateNpmUpdates,
} from "../scripts/validate-npm-update.mjs";

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
    dependencies: structuredClone(headPackage.dependencies ?? {}),
    devDependencies: structuredClone(headPackage.devDependencies ?? {}),
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

test("accepts an update confined to the smoke runtime package", () => {
  const productionPackage = {
    name: "production",
    version: "1.0.0",
    private: true,
    dependencies: { runtime: "1.0.0" },
  };
  const smokeBase = {
    name: "smoke-runtime",
    version: "0.0.0",
    private: true,
    devDependencies: { pi: "2.0.0" },
  };
  const smokeHead = {
    ...structuredClone(smokeBase),
    devDependencies: { pi: "2.1.0" },
  };

  assert.deepEqual(
    validateNpmUpdates([
      {
        path: "package.json",
        basePackage: productionPackage,
        headPackage: structuredClone(productionPackage),
        lockRoot: matchingLock(productionPackage),
      },
      {
        path: "tests/smoke-runtime/package.json",
        basePackage: smokeBase,
        headPackage: smokeHead,
        lockRoot: matchingLock(smokeHead),
      },
    ]),
    [
      {
        path: "tests/smoke-runtime/package.json",
        section: "devDependencies",
        name: "pi",
        from: "2.0.0",
        to: "2.1.0",
      },
    ],
  );
});

test("rejects an aggregate update with no dependency changes", () => {
  assert.throws(
    () =>
      validateNpmUpdates([
        {
          path: "package.json",
          basePackage,
          headPackage: structuredClone(basePackage),
          lockRoot: matchingLock(basePackage),
        },
      ]),
    /must change at least one direct dependency or devDependency/,
  );
});
