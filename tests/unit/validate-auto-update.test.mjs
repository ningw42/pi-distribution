import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { authorizePendingUpdate, authorizeUpdate, validateUpdate } from "../../scripts/validate-auto-update.mjs";

const repository = "owner/pi-distribution";
const actor = "renovate-maintainer";
const mergeSha = "a".repeat(40);
const rootPaths = ["package.json", "package-lock.json"];
const smokePaths = ["tests/smoke-runtime/package.json", "tests/smoke-runtime/package-lock.json"];
const rtkPaths = ["vendor/pi-rtk/index.ts", "vendor/pi-rtk/LICENSE", "vendor/pi-rtk/metadata.json"];
const npmScope = { npm: true, rtk: false, updateClass: "npm" };
const rtkScope = { npm: false, rtk: true, updateClass: "pi-rtk" };
const mixedScope = { npm: true, rtk: true, updateClass: "dependencies" };
const validator = fileURLToPath(new URL("../../scripts/validate-auto-update.mjs", import.meta.url));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const apiFiles = (paths) => paths.map((filename) => ({ filename, status: "modified" }));

function pullRequest(paths = rootPaths, sha = mergeSha) {
  return {
    merged: true,
    base: { ref: "master", repo: { full_name: repository } },
    head: { ref: "renovate/dependencies", repo: { full_name: repository } },
    user: { login: actor },
    labels: [{ name: "dependencies" }, { name: "auto-release:dependencies" }],
    merge_commit_sha: sha,
    changed_files: paths.length,
  };
}

function authorize(paths, sha = mergeSha) {
  return authorizeUpdate(pullRequest(paths, sha), apiFiles(paths), { repository, actor, mergeSha: sha });
}

function pendingPullRequest(paths = rootPaths, sha = mergeSha) {
  const pr = pullRequest(paths, sha);
  pr.merged = false;
  pr.merge_commit_sha = null;
  pr.head.sha = sha;
  return pr;
}

test("pending authorization accepts npm-only, RTK-only, and mixed updates", () => {
  for (const [paths, expected] of [
    [rootPaths, npmScope], [[rtkPaths[2]], rtkScope], [[...rootPaths, ...rtkPaths], mixedScope],
  ]) {
    assert.deepEqual(
      authorizePendingUpdate(pendingPullRequest(paths), apiFiles(paths), { repository, actor, headSha: mergeSha }),
      expected,
    );
  }
});

test("pending authorization requires an unmerged PR and the exact configured head SHA", () => {
  for (const merged of [true, null, undefined, "false", 0]) {
    const pr = pendingPullRequest();
    pr.merged = merged;
    assert.throws(
      () => authorizePendingUpdate(pr, apiFiles(rootPaths), { repository, actor, headSha: mergeSha }),
      /must be unmerged/,
    );
  }
  for (const headSha of [undefined, "", "HEAD", "a".repeat(39), "g".repeat(40), "b".repeat(40)]) {
    assert.throws(
      () => authorizePendingUpdate(pendingPullRequest(), apiFiles(rootPaths), { repository, actor, headSha }),
      /HEAD_SHA|head commit mismatch/,
    );
  }
  const pr = pendingPullRequest();
  delete pr.head.sha;
  assert.throws(
    () => authorizePendingUpdate(pr, apiFiles(rootPaths), { repository, actor, headSha: mergeSha }),
    /head commit mismatch/,
  );
});

test("pending authorization preserves the shared identity, branch, label, and file policy", () => {
  const options = { repository, actor, headSha: mergeSha };
  for (const mutate of [
    (pr) => { pr.user.login = "attacker"; },
    (pr) => { pr.base.ref = "main"; },
    (pr) => { pr.base.repo.full_name = "attacker/repository"; },
    (pr) => { pr.head.repo.full_name = "attacker/repository"; },
    (pr) => { pr.head.ref += "-extra"; },
    (pr) => { pr.labels = []; },
    (pr) => { pr.changed_files++; },
  ]) {
    const pr = pendingPullRequest();
    mutate(pr);
    assert.throws(() => authorizePendingUpdate(pr, apiFiles(rootPaths), options));
  }
  assert.throws(
    () => authorizePendingUpdate(pendingPullRequest(), apiFiles(rootPaths), { ...options, actor: "" }),
    /RENOVATE_ACTOR/,
  );
  for (const paths of [[], [rootPaths[0]], ["README.md"], [rtkPaths[0]]]) {
    assert.throws(() => authorizePendingUpdate(pendingPullRequest(paths), apiFiles(paths), options));
  }
  const files = apiFiles(rootPaths);
  files[0].status = "renamed";
  assert.throws(() => authorizePendingUpdate(pendingPullRequest(), files, options), /modified only/);
});

function fixture(t, { prepareBase = () => {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "validate-auto-update-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const write = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const readJson = (path) => JSON.parse(readFileSync(join(cwd, path), "utf8"));
  const writeJson = (path, value) => write(path, jsonText(value));
  const commit = () => {
    git("commit", "--allow-empty", "-m", "fixture snapshot");
    return git("rev-parse", "HEAD");
  };
  const save = () => {
    git("add", "--all");
    return commit();
  };
  const writePackage = (paths, pkg) => {
    writeJson(paths[0], pkg);
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    writeJson(paths[1], {
      name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
      packages: {
        "": { name: pkg.name, version: pkg.version, ...(pkg.dependencies && { dependencies: pkg.dependencies }), ...(pkg.devDependencies && { devDependencies: pkg.devDependencies }) },
        ...Object.fromEntries(Object.entries(dependencies).map(([name, version]) => [
          `node_modules/${name}`, { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` },
        ])),
      },
    });
  };
  const npm = (paths = rootPaths, version = "1.1.0") => {
    const pkg = readJson(paths[0]);
    const section = paths === rootPaths ? "dependencies" : "devDependencies";
    pkg[section][Object.keys(pkg[section])[0]] = version;
    writePackage(paths, pkg);
  };
  const rtk = (version = "1.1.0", { source = "// generated RTK integration\n", license = "MIT License\n" } = {}) => {
    write(rtkPaths[0], source);
    write(rtkPaths[1], license);
    writeJson(rtkPaths[2], {
      schemaVersion: 1,
      upstreamRepository: "rtk-ai/rtk",
      version, tag: `v${version}`, commit: hash(version).slice(0, 40),
      generatorCommand: "rtk init -g --agent pi --no-patch",
      upstreamSourcePath: "hooks/pi/rtk.ts",
      generatedSourceSha256: hash(source), licenseSha256: hash(license),
    });
  };
  // Stage symlinks through the index so this also tests native Windows without
  // requiring symlink privileges or trusting core.symlinks checkout behavior.
  const setMode = (path, mode, content) => {
    const object = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd, input: content, encoding: "utf8",
    }).trim();
    git("update-index", "--add", "--cacheinfo", `${mode},${object},${path}`);
  };
  git("init", "--quiet");
  git("config", "user.name", "Validator test");
  git("config", "user.email", "validator@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(cwd, "no-hooks"));
  git("config", "core.autocrlf", "false");
  writePackage(rootPaths, {
    name: "fixture", version: "0.1.0", private: true,
    scripts: { postinstall: "node -e \"throw new Error('must not execute package scripts')\"" },
    dependencies: { runtime: "1.0.0" },
  });
  writePackage(smokePaths, {
    name: "smoke-runtime", version: "0.0.0", private: true,
    devDependencies: { pi: "1.0.0" },
  });
  rtk("1.0.0");
  write("scripts/rtk-candidate.mjs", "throw new Error('must not import candidate code');\n");
  const repo = { cwd, git, write, readJson, writeJson, commit, save, npm, rtk, setMode };
  prepareBase(repo);
  return { ...repo, base: save() };
}

test("authorizes and validates an npm-only committed update", (t) => {
  const repo = fixture(t);
  repo.npm();
  const head = repo.save();
  const scope = authorize(rootPaths, head);
  assert.deepEqual(scope, npmScope);
  assert.deepEqual(validateUpdate(repo.base, head, scope, repo), npmScope);
});

for (const [name, paths, expected, update] of [
  ["smoke-runtime-only", smokePaths, npmScope, (repo) => repo.npm(smokePaths)],
  ["both npm packages", [...rootPaths, ...smokePaths], npmScope, (repo) => { repo.npm(); repo.npm(smokePaths); }],
  ["RTK metadata-only", [rtkPaths[2]], rtkScope, (repo) => repo.rtk()],
  ["RTK source and license", rtkPaths, rtkScope, (repo) => repo.rtk("1.1.0", { source: "// new RTK\n", license: "MIT License\nnew attribution\n" })],
  ["mixed npm and RTK", [...rootPaths, rtkPaths[2]], mixedScope, (repo) => { repo.npm(); repo.rtk(); }],
  ["mixed smoke-runtime and RTK", [...smokePaths, rtkPaths[2]], mixedScope, (repo) => { repo.npm(smokePaths); repo.rtk(); }],
  ["all allowed files", [...rootPaths, ...smokePaths, ...rtkPaths], mixedScope, (repo) => {
    repo.npm(); repo.npm(smokePaths);
    repo.rtk("2.0.0", { source: "// RTK 2\n", license: "MIT License\nupdated\n" });
  }],
]) {
  test(`accepts ${name} updates`, (t) => {
    const repo = fixture(t);
    update(repo);
    const head = repo.save();
    const scope = authorize([...paths].reverse(), head);
    assert.deepEqual(scope, expected);
    assert.deepEqual(validateUpdate(repo.base, head, scope, repo), expected);
  });
}

for (const [name, mutate, message] of [
  ["unmerged PR", (pr) => { pr.merged = false; }, /must be merged/],
  ["truthy non-boolean merged flag", (pr) => { pr.merged = "true"; }, /must be merged/],
  ["wrong base branch", (pr) => { pr.base.ref = "main"; }, /base must be master/],
  ["wrong base repository", (pr) => { pr.base.repo.full_name = "attacker/pi-distribution"; }, /base repository/],
  ["fork head repository", (pr) => { pr.head.repo.full_name = "attacker/pi-distribution"; }, /head repository/],
  ["case-different repository", (pr) => { pr.head.repo.full_name = "Owner/pi-distribution"; }, /head repository/],
  ["missing head repository", (pr) => { pr.head.repo = null; }, /head repository/],
  ["wrong author", (pr) => { pr.user.login = "renovate[bot]"; }, /author/],
  ["case-different author", (pr) => { pr.user.login = actor.toUpperCase(); }, /author/],
  ["missing author", (pr) => { delete pr.user; }, /author/],
  ["branch suffix", (pr) => { pr.head.ref += "-npm"; }, /exact grouped Renovate branch/],
  ["old npm branch", (pr) => { pr.head.ref = "renovate/npm-updates"; }, /exact grouped Renovate branch/],
  ["ref prefix", (pr) => { pr.head.ref = "refs/heads/renovate/dependencies"; }, /exact grouped Renovate branch/],
  ["missing label", (pr) => { pr.labels = []; }, /label/],
  ["old npm label", (pr) => { pr.labels = [{ name: "auto-release:npm" }]; }, /label/],
  ["label prefix", (pr) => { pr.labels = [{ name: "auto-release:dependencies-extra" }]; }, /label/],
  ["string instead of label object", (pr) => { pr.labels = ["auto-release:dependencies"]; }, /label/],
  ["missing labels", (pr) => { pr.labels = null; }, /label/],
  ["wrong merge SHA", (pr) => { pr.merge_commit_sha = "b".repeat(40); }, /merge commit/],
  ["incomplete file list", (pr) => { pr.changed_files++; }, /changed_files/],
  ["excess file list", (pr) => { pr.changed_files--; }, /changed_files/],
  ["string file count", (pr) => { pr.changed_files = "2"; }, /changed_files/],
]) {
  test(`authorization rejects ${name}`, () => {
    const pr = pullRequest();
    mutate(pr);
    assert.throws(() => authorizeUpdate(pr, apiFiles(rootPaths), { repository, actor, mergeSha }), message);
  });
}

for (const invalidActor of [undefined, null, "", " ", "renovate[bot]", "bad_name", "-bad", "bad-", "bad--name", "a".repeat(40), "name\n", 42]) {
  test(`authorization fails closed for actor ${JSON.stringify(invalidActor)}`, () => {
    const pr = pullRequest();
    pr.user.login = invalidActor;
    assert.throws(() => authorizeUpdate(pr, apiFiles(rootPaths), { repository, actor: invalidActor, mergeSha }));
  });
}

test("authorization requires explicit repository and full merge SHA", () => {
  for (const options of [
    { actor, mergeSha }, { repository: "", actor, mergeSha },
    { repository, actor }, { repository, actor, mergeSha: "HEAD" },
    { repository, actor, mergeSha: "a".repeat(39) },
    { repository, actor, mergeSha: "g".repeat(40) },
  ]) {
    assert.throws(() => authorizeUpdate(pullRequest(), apiFiles(rootPaths), options));
  }
});

for (const status of ["added", "removed", "renamed", "copied", "changed", undefined]) {
  test(`authorization rejects file status ${status}`, () => {
    const files = apiFiles(rootPaths);
    files[0].status = status;
    assert.throws(() => authorizeUpdate(pullRequest(), files, { repository, actor, mergeSha }), /modified only/);
  });
}

test("authorization rejects disguised renames and duplicate files", () => {
  const files = apiFiles(rootPaths);
  files[0].previous_filename = "old-package.json";
  assert.throws(() => authorizeUpdate(pullRequest(), files, { repository, actor, mergeSha }), /renamed/);
  assert.throws(() => authorize([...rootPaths, rootPaths[0]]), /duplicate/);
});

for (const path of [
  "README.md", "scripts/validate-auto-update.mjs", "../package.json", "./package.json",
  "/package.json", "vendor/pi-rtk/../pi-statusline/index.ts", "vendor/pi-rtk/extra.ts",
  "vendor/pi-rtk/index.ts/child", "vendor\\pi-rtk\\index.ts", "package.json\n",
  "package.json\0", ":(glob)**", "--output=package.json",
]) {
  test(`authorization rejects malicious or unexpected path ${JSON.stringify(path)}`, () => {
    assert.throws(() => authorize([...rootPaths, path]), /unauthorized changed path/);
  });
}

for (const paths of [[rootPaths[0]], [rootPaths[1]], [smokePaths[0]], [smokePaths[1]]]) {
  test(`authorization rejects unpaired ${paths[0]}`, () => {
    assert.throws(() => authorize(paths), /must change together/);
  });
}

test("authorization rejects empty changes, missing RTK metadata, and non-array files", () => {
  assert.throws(() => authorize([]), /at least one file/);
  assert.throws(() => authorize([rtkPaths[0]]), /include metadata/);
  assert.throws(() => authorize([rtkPaths[1]]), /include metadata/);
  assert.throws(() => authorizeUpdate(pullRequest(), {}, { repository, actor, mergeSha }), /must be an array/);
});

// Semantic validation uses real Git commits, never mocks of Git or validators.
for (const [name, update, message] of [
  ["package metadata edits", (repo) => {
    const pkg = repo.readJson(rootPaths[0]); pkg.scripts.postinstall = "malicious-command";
    repo.writeJson(rootPaths[0], pkg);
  }, /outside dependencies/],
  ["added dependency names", (repo) => {
    const pkg = repo.readJson(rootPaths[0]); pkg.dependencies.extra = "1.0.0";
    repo.writeJson(rootPaths[0], pkg);
  }, /dependency names|dependencies names/],
  ["removed dependency names", (repo) => {
    const pkg = repo.readJson(rootPaths[0]); delete pkg.dependencies.runtime;
    repo.writeJson(rootPaths[0], pkg);
  }, /dependencies names/],
  ["unpinned versions", (repo) => repo.npm(rootPaths, "^1.1.0"), /exactly pinned/],
  ["stale root lock pins", (repo) => {
    const lock = repo.readJson(rootPaths[1]); lock.packages[""].dependencies.runtime = "0.9.0";
    repo.writeJson(rootPaths[1], lock);
  }, /lockfile root dependencies/],
  ["stale smoke lock pins", (repo) => {
    repo.npm(smokePaths);
    const lock = repo.readJson(smokePaths[1]); lock.packages[""].devDependencies.pi = "0.9.0";
    repo.writeJson(smokePaths[1], lock);
  }, /lockfile root devDependencies/],
  ["missing lock root", (repo) => repo.writeJson(rootPaths[1], { lockfileVersion: 3 }), /lockfile root package/],
]) {
  test(`semantic validation rejects ${name}`, (t) => {
    const repo = fixture(t);
    repo.npm();
    update(repo);
    assert.throws(() => validateUpdate(repo.base, repo.save(), npmScope, repo), message);
  });
}

test("rejects no-op commits and formatting-only npm changes", (t) => {
  const repo = fixture(t);
  assert.throws(() => validateUpdate(repo.base, repo.base, npmScope, repo), /at least one file/);
  for (const path of rootPaths) repo.write(path, JSON.stringify(repo.readJson(path)));
  const head = repo.save();
  assert.throws(() => validateUpdate(repo.base, head, authorize(rootPaths, head), repo), /at least one direct dependency/);
});

for (const [name, update, message] of [
  ["source hash mismatch", (repo) => repo.write(rtkPaths[0], "// tampered source\n"), /source hash mismatch/],
  ["license hash mismatch", (repo) => repo.write(rtkPaths[1], "tampered license\n"), /license hash mismatch/],
  ["unexpected metadata keys", (repo) => {
    const metadata = repo.readJson(rtkPaths[2]); metadata.extra = "untrusted";
    repo.writeJson(rtkPaths[2], metadata);
  }, /unexpected RTK metadata fields/],
  ["invalid schema", (repo) => {
    const metadata = repo.readJson(rtkPaths[2]); metadata.schemaVersion = 2;
    repo.writeJson(rtkPaths[2], metadata);
  }, /2 !== 1/],
  ["tag/version mismatch", (repo) => {
    const metadata = repo.readJson(rtkPaths[2]); metadata.tag = "v9.9.9";
    repo.writeJson(rtkPaths[2], metadata);
  }, /v9\.9\.9/],
  ["RTK downgrade", (repo) => repo.rtk("0.9.9"), /strictly advance/],
  ["unchanged RTK version", (repo) => repo.rtk("1.0.0", { source: "// rebuilt same release\n" }), /strictly advance/],
]) {
  test(`semantic validation rejects ${name}`, (t) => {
    const repo = fixture(t);
    repo.rtk();
    update(repo);
    assert.throws(() => validateUpdate(repo.base, repo.save(), rtkScope, repo), message);
  });
}

test("compares RTK versions numerically rather than lexicographically", (t) => {
  const repo = fixture(t, { prepareBase: (repo) => repo.rtk("1.9.9") });
  repo.rtk("1.10.0");
  assert.deepEqual(validateUpdate(repo.base, repo.save(), rtkScope, repo), rtkScope);
});

for (const path of [rtkPaths[0], rtkPaths[1], rtkPaths[2]]) {
  test(`validates base RTK snapshot integrity for ${path}`, (t) => {
    const repo = fixture(t, { prepareBase: (repo) => {
      if (path === rtkPaths[2]) {
        const metadata = repo.readJson(path); metadata.extra = true;
        repo.writeJson(path, metadata);
      } else repo.write(path, "corrupt base snapshot\n");
    } });
    repo.rtk();
    assert.throws(() => validateUpdate(repo.base, repo.save(), rtkScope, repo), /hash mismatch|unexpected RTK metadata fields/);
  });
}

test("npm-only updates also validate unchanged RTK hashes", (t) => {
  const repo = fixture(t, { prepareBase: (repo) => repo.write(rtkPaths[0], "corrupt source\n") });
  repo.npm();
  assert.throws(() => validateUpdate(repo.base, repo.save(), npmScope, repo), /source hash mismatch/);
});

test("rejects RTK byte changes in an npm-only scope", (t) => {
  const repo = fixture(t);
  repo.npm();
  repo.write(rtkPaths[2], JSON.stringify(repo.readJson(rtkPaths[2])));
  const head = repo.save();
  assert.throws(() => validateUpdate(repo.base, head, authorize(rootPaths, head), repo), /authorized update scope|byte-identical/);
});

test("checks the complete API path set, not just the npm/RTK classification", (t) => {
  const repo = fixture(t);
  repo.npm(); repo.npm(smokePaths);
  const head = repo.save();
  assert.throws(() => validateUpdate(repo.base, head, authorize(rootPaths, head), repo), /paths do not match/);
  const all = [...rootPaths, ...smokePaths];
  assert.deepEqual(validateUpdate(repo.base, head, authorize(all, head), repo), npmScope);
});

test("rejects a fabricated extra API path and a different merge commit", (t) => {
  const repo = fixture(t);
  repo.npm();
  const head = repo.save();
  assert.throws(() => validateUpdate(repo.base, head, authorize([...rootPaths, ...smokePaths], head), repo), /paths do not match/);
  assert.throws(() => validateUpdate(repo.base, head, authorize(rootPaths), repo), /authorized merge commit/);
});

for (const [name, update, message] of [
  ["an extra modified repository script", (repo) => repo.write("scripts/rtk-candidate.mjs", "// changed code\n"), /unauthorized changed path/],
  ["an added file", (repo) => repo.write("new-file", "new\n"), /modified only/],
  ["a deleted allowed file", (repo) => rmSync(join(repo.cwd, rtkPaths[1])), /modified only/],
  ["an unpaired lock", (repo) => repo.writeJson(rootPaths[0], JSON.parse(repo.git("show", `${repo.base}:package.json`))), /must change together/],
  ["RTK source without metadata", (repo) => repo.write(rtkPaths[0], "// changed without metadata\n"), /include metadata/],
  ["an allowed file renamed outside the allowlist", (repo) => repo.git("mv", rtkPaths[1], "renamed-license"), /modified only/],
]) {
  test(`Git diff rejects ${name} even when absent from the API list`, (t) => {
    const repo = fixture(t);
    repo.npm();
    update(repo);
    const head = repo.save();
    assert.throws(() => validateUpdate(repo.base, head, authorize(rootPaths, head), repo), message);
  });
}

for (const mode of ["100755", "120000"]) {
  for (const path of [...rootPaths, ...smokePaths, ...rtkPaths]) {
    test(`rejects committed mode ${mode} for ${path}`, (t) => {
      const repo = fixture(t);
      repo.npm(); repo.npm(smokePaths);
      repo.rtk("1.1.0", { source: "// changed\n", license: "MIT License\nupdated\n" });
      repo.git("add", "--all");
      repo.setMode(path, mode, mode === "120000" ? "../../outside" : readFileSync(join(repo.cwd, path)));
      const head = repo.commit();
      assert.throws(
        () => validateUpdate(repo.base, head, authorize([...rootPaths, ...smokePaths, ...rtkPaths], head), repo),
        /100644|type changes/,
      );
    });
  }
}

for (const mode of ["100755", "120000"]) {
  test(`rejects unchanged RTK files with base mode ${mode}`, (t) => {
    const repo = fixture(t);
    repo.setMode(rtkPaths[0], mode, mode === "120000" ? "../../outside" : readFileSync(join(repo.cwd, rtkPaths[0])));
    const base = repo.commit();
    repo.npm();
    repo.git("add", "--", ...rootPaths);
    const head = repo.commit();
    assert.throws(() => validateUpdate(base, head, authorize(rootPaths, head), repo), /100644/);
  });
}

test("rejects refs, revision expressions, absent objects, and non-commit objects", (t) => {
  const repo = fixture(t);
  repo.npm();
  const head = repo.save();
  for (const sha of ["HEAD", `${head}^1`, "--help", "a".repeat(39), "g".repeat(40)]) {
    assert.throws(() => validateUpdate(sha, head, npmScope, repo), /40-hex/);
    assert.throws(() => validateUpdate(repo.base, sha, npmScope, repo), /40-hex/);
  }
  assert.throws(() => validateUpdate(repo.base, "0".repeat(40), npmScope, repo));
  const blob = repo.git("rev-parse", `${head}:package.json`);
  assert.throws(() => validateUpdate(repo.base, blob, npmScope, repo), /must identify a commit/);
});

test("rejects inconsistent or malformed scopes", (t) => {
  const repo = fixture(t);
  repo.npm();
  const head = repo.save();
  for (const scope of [null, {}, { ...npmScope, npm: "true" }, { ...npmScope, updateClass: "dependencies" }, rtkScope, mixedScope]) {
    assert.throws(() => validateUpdate(repo.base, head, scope, repo));
  }
});

test("pending semantic validation binds both the head commit and complete API paths", (t) => {
  const repo = fixture(t);
  repo.npm(); repo.npm(smokePaths);
  const head = repo.save();
  const options = { repository, actor, headSha: head };
  const incomplete = authorizePendingUpdate(pendingPullRequest(rootPaths, head), apiFiles(rootPaths), options);
  assert.throws(() => validateUpdate(repo.base, head, incomplete, repo), /paths do not match/);
  const paths = [...rootPaths, ...smokePaths];
  const scope = authorizePendingUpdate(pendingPullRequest(paths, head), apiFiles(paths), options);
  assert.throws(() => validateUpdate(repo.base, repo.base, scope, repo), /authorized head commit/);
  assert.deepEqual(validateUpdate(repo.base, head, scope, repo), npmScope);
});

test("compares repository-relative paths even from a subdirectory with diff.relative enabled", (t) => {
  const repo = fixture(t);
  repo.npm(smokePaths);
  const head = repo.save();
  repo.git("config", "diff.relative", "true");
  assert.deepEqual(
    validateUpdate(repo.base, head, authorize(smokePaths, head), { cwd: join(repo.cwd, "tests", "smoke-runtime") }),
    npmScope,
  );
});

test("reads exact revisions despite dirty files, another checkout, or replace refs", (t) => {
  const repo = fixture(t);
  repo.npm();
  const head = repo.save();
  repo.git("replace", head, repo.base);
  repo.git("checkout", "--detach", repo.base);
  for (const path of [...rootPaths, ...smokePaths, ...rtkPaths]) repo.write(path, "invalid dirty data\n");
  repo.git("config", "diff.external", "must-not-execute-this");
  assert.deepEqual(validateUpdate(repo.base, head, authorize(rootPaths, head), repo), npmScope);
});

function runCli(repo, paths, head, { pending = false, semantic = true, env = {}, extraArgs = [] } = {}) {
  const prPath = join(repo.cwd, ".git", "pr.json");
  const filesPath = join(repo.cwd, ".git", "files.json");
  writeFileSync(prPath, jsonText(pending ? pendingPullRequest(paths, head) : pullRequest(paths, head)));
  writeFileSync(filesPath, jsonText(apiFiles(paths)));
  return spawnSync(process.execPath, [validator, ...(pending ? ["--pending"] : []), prPath, filesPath, ...(semantic ? [repo.base, head] : []), ...extraArgs], {
    cwd: repo.cwd, encoding: "utf8",
    env: { ...process.env, REPOSITORY: repository, RENOVATE_ACTOR: actor, MERGE_SHA: head, HEAD_SHA: head, ...env },
  });
}

for (const [paths, expected, update] of [
  [rootPaths, "npm", (repo) => repo.npm()],
  [[rtkPaths[2]], "pi-rtk", (repo) => repo.rtk()],
  [[...rootPaths, rtkPaths[2]], "dependencies", (repo) => { repo.npm(); repo.rtk(); }],
]) {
  test(`CLI prints only ${expected} in merged and pending modes`, (t) => {
    const repo = fixture(t);
    update(repo);
    const head = repo.save();
    for (const options of [{ semantic: false }, { semantic: true }, { pending: true, env: { MERGE_SHA: "" } }]) {
      const result = runCli(repo, paths, head, options);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${expected}\n`);
      assert.equal(result.stderr, "");
    }
  });
}

test("CLI fails closed without stdout for authorization, usage, or semantic failures", (t) => {
  const repo = fixture(t);
  repo.npm();
  const head = repo.save();
  for (const options of [
    { env: { RENOVATE_ACTOR: "" } }, { env: { RENOVATE_ACTOR: "wrong-user" } },
    { env: { REPOSITORY: "attacker/pi-distribution" } }, { env: { MERGE_SHA: "HEAD" } },
    { semantic: false, extraArgs: [repo.base] }, { extraArgs: ["unexpected"] },
    { semantic: false, extraArgs: ["", head] },
  ]) {
    const result = runCli(repo, rootPaths, head, options);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
  }
  repo.rtk("0.9.0");
  const downgraded = repo.save();
  for (const pending of [false, true]) {
    const result = runCli(repo, [...rootPaths, rtkPaths[2]], downgraded, { pending });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /strictly advance/);
  }
});

test("pending CLI rejects missing or mismatched HEAD_SHA and cannot skip semantic validation", (t) => {
  const repo = fixture(t);
  repo.npm();
  const head = repo.save();
  for (const [options, message] of [
    [{ env: { HEAD_SHA: "" } }, /HEAD_SHA/],
    [{ env: { HEAD_SHA: "b".repeat(40) } }, /head commit mismatch/],
    [{ env: { RENOVATE_ACTOR: "wrong-user" } }, /author/],
    [{ semantic: false }, /usage/],
    [{ semantic: false, extraArgs: [repo.base] }, /usage/],
    [{ semantic: false, extraArgs: ["", head] }, /40-hex/],
    [{ semantic: false, extraArgs: [repo.base, repo.base] }, /authorized head commit/],
  ]) {
    const result = runCli(repo, rootPaths, head, { ...options, pending: true });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});
