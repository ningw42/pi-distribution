import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareRtkVersions, validateRtkFiles } from "./rtk-candidate.mjs";
import { validateNpmUpdate } from "./validate-npm-update.mjs";

const packagePairs = [
  ["package.json", "package-lock.json"],
  ["tests/smoke-runtime/package.json", "tests/smoke-runtime/package-lock.json"],
];
const rtkPaths = [
  "vendor/pi-rtk/index.ts",
  "vendor/pi-rtk/LICENSE",
  "vendor/pi-rtk/metadata.json",
];
const allowedPaths = new Set([...packagePairs.flat(), ...rtkPaths]);
const shaPattern = /^[0-9a-f]{40}$/i;
const loginPattern = /^(?=.{1,39}$)[a-z0-9]+(?:-[a-z0-9]+)*$/i;
// Preserve the public scope shape while binding in-process authorization to the
// complete API file list and authorized commit. A reconstructed scope cannot retain
// that binding; validateUpdate still independently checks its actual Git diff.
const authorizations = new WeakMap();

function classifyPaths(paths) {
  assert.ok(paths.length > 0, "update must change at least one file");
  const changed = new Set(paths);
  assert.equal(changed.size, paths.length, "duplicate changed paths");
  for (const path of changed) {
    assert.ok(allowedPaths.has(path), `unauthorized changed path: ${path}`);
  }
  for (const [packagePath, lockPath] of packagePairs) {
    assert.equal(
      changed.has(packagePath),
      changed.has(lockPath),
      `${packagePath} and ${lockPath} must change together`,
    );
  }
  const npm = packagePairs.some(([path]) => changed.has(path));
  const rtk = rtkPaths.some((path) => changed.has(path));
  assert.ok(!rtk || changed.has("vendor/pi-rtk/metadata.json"), "RTK changes must include metadata.json");
  return { npm, rtk, updateClass: npm && rtk ? "dependencies" : npm ? "npm" : "pi-rtk" };
}

function authorizeCommonUpdate(pr, files, { repository, actor, expectedSha, merged }) {
  assert.match(actor ?? "", loginPattern, "RENOVATE_ACTOR must be an explicitly configured GitHub login");
  assert.match(repository ?? "", /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i, "REPOSITORY must be owner/repository");
  assert.match(expectedSha ?? "", shaPattern, `${merged ? "MERGE_SHA" : "HEAD_SHA"} must be a full 40-hex commit SHA`);
  assert.equal(pr?.merged, merged, merged ? "PR must be merged" : "PR must be unmerged");
  assert.equal(pr?.base?.ref, "master", "PR base must be master");
  assert.equal(pr?.base?.repo?.full_name, repository, "PR base repository mismatch");
  assert.equal(pr?.head?.repo?.full_name, repository, "PR head repository mismatch");
  assert.equal(pr?.user?.login, actor, "PR author must match RENOVATE_ACTOR");
  assert.equal(pr?.head?.ref, "renovate/dependencies", "PR must use the exact grouped Renovate branch");
  assert.ok(
    Array.isArray(pr?.labels) && pr.labels.some((label) => label?.name === "auto-release:dependencies"),
    "PR must have the auto-release:dependencies label",
  );
  const commitKind = merged ? "merge" : "head";
  assert.equal(merged ? pr?.merge_commit_sha : pr?.head?.sha, expectedSha, `PR ${commitKind} commit mismatch`);
  assert.ok(Array.isArray(files), "PR files must be an array");
  assert.equal(pr?.changed_files, files.length, "PR changed_files must match the complete file list");
  const paths = files.map((file) => {
    assert.equal(file?.status, "modified", "PR files must be modified only");
    assert.ok(!Object.hasOwn(file, "previous_filename"), "renamed PR files are not allowed");
    return file.filename;
  });
  const scope = Object.freeze(classifyPaths(paths));
  authorizations.set(scope, { paths: [...paths].sort(), headSha: expectedSha, commitKind });
  return scope;
}

export function authorizeUpdate(pr, files, { repository, actor, mergeSha } = {}) {
  return authorizeCommonUpdate(pr, files, { repository, actor, expectedSha: mergeSha, merged: true });
}

export function authorizePendingUpdate(pr, files, { repository, actor, headSha } = {}) {
  return authorizeCommonUpdate(pr, files, { repository, actor, expectedSha: headSha, merged: false });
}

export function validateUpdate(baseSha, headSha, scope, { cwd = process.cwd() } = {}) {
  assert.match(baseSha, shaPattern, "base SHA must be a full 40-hex commit SHA");
  assert.match(headSha, shaPattern, "head SHA must be a full 40-hex commit SHA");
  assert.equal(typeof scope?.npm, "boolean", "scope.npm must be boolean");
  assert.equal(typeof scope?.rtk, "boolean", "scope.rtk must be boolean");
  const authorization = authorizations.get(scope);
  if (authorization) {
    assert.equal(headSha, authorization.headSha, `head SHA must match the authorized ${authorization.commitKind} commit`);
  }

  // Never use a shell, checkout, filters, textconv, external diff, or imports
  // from the candidate revision. Disable replace refs so SHAs mean exact objects.
  const git = (...args) => execFileSync(
    "git",
    ["--no-pager", "--no-replace-objects", "--literal-pathspecs", ...args],
    { cwd, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const sha of [baseSha, headSha]) {
    assert.equal(git("cat-file", "-t", sha).toString().trim(), "commit", `${sha} must identify a commit`);
  }

  const diff = git(
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--ignore-submodules=none",
    "--name-status", "-z", baseSha, headSha, "--",
  ).toString("utf8");
  const entries = diff ? diff.split("\0") : [];
  if (entries.length) assert.equal(entries.pop(), "", "invalid Git diff output");
  assert.equal(entries.length % 2, 0, "invalid Git diff entries");
  const paths = [];
  for (let i = 0; i < entries.length; i += 2) {
    assert.equal(entries[i], "M", "Git changes must be modified only (no additions, deletions, renames, or type changes)");
    paths.push(entries[i + 1]);
  }
  const actualScope = classifyPaths(paths);
  assert.deepEqual(scope, actualScope, "Git diff does not match the authorized update scope");
  if (authorization) {
    assert.deepEqual([...paths].sort(), authorization.paths, "Git diff paths do not match the authorized PR files");
  }

  const readSnapshot = (sha) => {
    const tree = git("ls-tree", "-r", "-z", "--full-tree", sha, "--", ...allowedPaths).toString("utf8");
    const modes = new Map(tree.split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      return [entry.slice(tab + 1), entry.slice(0, tab).split(" ").slice(0, 2).join(" ")];
    }));
    return Object.fromEntries([...allowedPaths].map((path) => {
      assert.equal(modes.get(path), "100644 blob", `${sha}:${path} must be a regular 100644 file`);
      return [path, git("show", "--no-ext-diff", "--no-textconv", `${sha}:${path}`)];
    }));
  };
  const base = readSnapshot(baseSha);
  const head = readSnapshot(headSha);
  const json = (snapshot, path) => JSON.parse(snapshot[path].toString("utf8"));
  const lockRoot = (snapshot, path) => {
    const root = json(snapshot, path)?.packages?.[""];
    assert.ok(root && typeof root === "object" && !Array.isArray(root), `${path} must have a lockfile root package`);
    return root;
  };

  const npmChanges = packagePairs.flatMap(([packagePath, lockPath]) => {
    const basePackage = json(base, packagePath);
    const headPackage = json(head, packagePath);
    validateNpmUpdate(basePackage, basePackage, lockRoot(base, lockPath), { requireChange: false });
    return validateNpmUpdate(basePackage, headPackage, lockRoot(head, lockPath), { requireChange: false });
  });
  if (scope.npm) {
    assert.ok(npmChanges.length > 0, "npm update must change at least one direct dependency or devDependency");
  }

  const rtkMetadata = (snapshot) => validateRtkFiles(
    json(snapshot, "vendor/pi-rtk/metadata.json"),
    snapshot["vendor/pi-rtk/index.ts"],
    snapshot["vendor/pi-rtk/LICENSE"],
  );
  const baseRtk = rtkMetadata(base);
  const headRtk = rtkMetadata(head);
  if (scope.rtk) {
    assert.ok(compareRtkVersions(headRtk.version, baseRtk.version) > 0, "RTK version must strictly advance");
  } else {
    for (const path of rtkPaths) {
      assert.ok(base[path].equals(head[path]), `npm-only update must leave ${path} byte-identical`);
    }
  }
  return scope;
}

function main() {
  const args = process.argv.slice(2);
  const pending = args[0] === "--pending";
  if (pending) args.shift();
  assert.ok(
    args.length === 4 || (!pending && args.length === 2),
    "usage: node scripts/validate-auto-update.mjs PR_JSON FILES_JSON [BASE_SHA HEAD_SHA]\n" +
      "       node scripts/validate-auto-update.mjs --pending PR_JSON FILES_JSON BASE_SHA HEAD_SHA",
  );
  const [prPath, filesPath, baseSha, headSha] = args;
  const authorize = pending ? authorizePendingUpdate : authorizeUpdate;
  const scope = authorize(
    JSON.parse(readFileSync(prPath, "utf8")),
    JSON.parse(readFileSync(filesPath, "utf8")),
    {
      repository: process.env.REPOSITORY,
      actor: process.env.RENOVATE_ACTOR,
      ...(pending ? { headSha: process.env.HEAD_SHA } : { mergeSha: process.env.MERGE_SHA }),
    },
  );
  if (args.length === 4) validateUpdate(baseSha, headSha, scope);
  process.stdout.write(`${scope.updateClass}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
