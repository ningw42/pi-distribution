import assert from "node:assert/strict";
import test from "node:test";

import {
  validateNpmUpdate,
  validateNpmUpdates,
} from "../../scripts/validate-npm-update.mjs";

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

const historySpec = (tag) => `git+https://github.com/ningw42/pi-history.git#${tag}`;

test("accepts a pinned pi-history GitHub release update alongside exact npm pins", () => {
  const base = structuredClone(basePackage);
  base.dependencies["pi-history"] = historySpec("v0.0.1");
  const head = structuredClone(base);
  head.dependencies["pi-history"] = historySpec("v1.2.3");
  assert.deepEqual(validateNpmUpdate(base, head, matchingLock(head)), [{
    section: "dependencies", name: "pi-history",
    from: historySpec("v0.0.1"), to: historySpec("v1.2.3"),
  }]);

  head.dependencies["pi-history"] = base.dependencies["pi-history"];
  head.dependencies.runtime = "1.1.0";
  assert.equal(validateNpmUpdate(base, head, matchingLock(head))[0].name, "runtime");
});

for (const spec of [
  "0.1.2", "npm:pi-history@0.1.2",
  "git+https://github.com/sagmans/pi-history.git#v0.1.2",
  "git+https://github.com/ningw42/pi-history-fork.git#v1.0.0",
  "https://github.com/ningw42/pi-history/archive/refs/tags/v1.0.0.tar.gz",
  ...["main", "latest", "semver:^1.0.0", "1.0.0", "v1.0", "v01.0.0", "v1.0.0-rc.1", "v1.0.0+build", "a".repeat(40), "v1.0.0/extra"].map(historySpec),
]) {
  test(`rejects pi-history source or release-pin drift: ${spec}`, () => {
    const base = structuredClone(basePackage);
    base.dependencies["pi-history"] = historySpec("v0.0.1");
    const head = structuredClone(base);
    head.dependencies["pi-history"] = spec;
    assert.throws(() => validateNpmUpdate(base, head, matchingLock(head)), /pi-history must remain exactly pinned/);
  });
}

test("the Git release exception does not allow arbitrary dependencies to switch sources", () => {
  const head = updatedPackage({ runtime: historySpec("v1.0.0") });
  assert.throws(() => validateNpmUpdate(basePackage, head, matchingLock(head)), /runtime must remain exactly pinned/);
});

test("a pi-history release update requires a matching lockfile pin", () => {
  const base = { dependencies: { "pi-history": historySpec("v0.0.1") } };
  const head = { dependencies: { "pi-history": historySpec("v0.0.2") } };
  assert.throws(() => validateNpmUpdate(base, head, matchingLock(base)), /lockfile root dependencies/);
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
