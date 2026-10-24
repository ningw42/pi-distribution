import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { applyRtkCandidate, compareRtkVersions, readRtkCandidate, validatePreparedCandidate } from "../../scripts/rtk-candidate.mjs";
import { requiredChecks, validateRenovateSetup } from "../../scripts/check-renovate-setup.mjs";
import { authorizePendingUpdate } from "../../scripts/validate-auto-update.mjs";

const policy = JSON.parse(readFileSync(new URL("../../renovate.json5", import.meta.url)));
const workflow = readFileSync(new URL("../../.github/workflows/renovate.yml", import.meta.url), "utf8");
const original = Object.fromEntries(["LICENSE", "index.ts", "metadata.json"].map((name) => [name, readFileSync(new URL(`../../vendor/pi-rtk/${name}`, import.meta.url))]));

function workflowStep(text, name) {
  const body = text.split(`      - name: ${name}\n`)[1];
  assert.ok(body, `missing workflow step: ${name}`);
  return body.split(/\n(?:      - name:|  [a-z][a-z-]*:)/)[0];
}

function stepCondition(step) {
  const folded = step.match(/^        if: >-\n((?:          .*\n)+)/m);
  return folded ? folded[1].trim().replace(/\s*\n\s*/g, " ") : step.match(/^        if: (.+)$/m)?.[1];
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rtk-candidate-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate"), repo = join(root, "repo"), target = join(repo, "vendor/pi-rtk");
  mkdirSync(candidate);
  mkdirSync(target, { recursive: true });
  for (const directory of [candidate, target]) {
    for (const [name, bytes] of Object.entries(original)) writeFileSync(join(directory, name), bytes);
  }
  return { root, candidate, repo, target };
}

function metadataAt(directory, change) {
  const path = join(directory, "metadata.json");
  const metadata = JSON.parse(readFileSync(path));
  change(metadata);
  writeFileSync(path, JSON.stringify(metadata));
}

test("RTK candidate copies all coherent artifacts without executing source", (t) => {
  const { candidate, repo, target } = fixture(t);
  metadataAt(candidate, (metadata) => { metadata.version = "99.0.0"; metadata.tag = "v99.0.0"; });
  // Simulate the deliberately incomplete regex update made by Renovate.
  metadataAt(target, (metadata) => { metadata.version = "99.0.0"; });
  applyRtkCandidate(candidate, repo);
  for (const name of Object.keys(original)) assert.deepEqual(readFileSync(join(target, name)), readFileSync(join(candidate, name)));
  assert.equal(readRtkCandidate(target).metadata.version, "99.0.0");
  applyRtkCandidate(candidate, repo); // Idempotent.
});

test("a candidate from another release cannot overwrite Renovate's selection", (t) => {
  const { candidate, repo, target } = fixture(t);
  metadataAt(target, (metadata) => { metadata.version = "99.0.0"; });
  assert.throws(() => applyRtkCandidate(candidate, repo), /does not match/);
  assert.equal(JSON.parse(readFileSync(join(target, "metadata.json"))).version, "99.0.0");
});

test("candidate rejects unexpected files, fields, and incoherent provenance", (t) => {
  const { candidate } = fixture(t);
  writeFileSync(join(candidate, "extra"), "untrusted");
  assert.throws(() => readRtkCandidate(candidate), /unexpected RTK candidate paths/);
  rmSync(join(candidate, "extra"));
  metadataAt(candidate, (metadata) => { metadata.extra = "untrusted"; });
  assert.throws(() => readRtkCandidate(candidate), /unexpected RTK metadata fields/);
  metadataAt(candidate, (metadata) => { delete metadata.extra; metadata.tag = "v0.0.0"; });
  assert.throws(() => readRtkCandidate(candidate));
  writeFileSync(join(candidate, "metadata.json"), original["metadata.json"]);
  writeFileSync(join(candidate, "index.ts"), "changed");
  assert.throws(() => readRtkCandidate(candidate), /source hash mismatch/);
  writeFileSync(join(candidate, "index.ts"), original["index.ts"]);
  writeFileSync(join(candidate, "LICENSE"), "changed");
  assert.throws(() => readRtkCandidate(candidate), /license hash mismatch/);
});

test("candidate and destination reject symlinks", { skip: process.platform === "win32" }, (t) => {
  const { candidate, root, repo, target } = fixture(t);
  const outside = join(root, "outside");
  writeFileSync(outside, original.LICENSE);
  rmSync(join(candidate, "LICENSE"));
  symlinkSync(outside, join(candidate, "LICENSE"));
  assert.throws(() => readRtkCandidate(candidate), /regular files/);
  rmSync(join(candidate, "LICENSE"));
  writeFileSync(join(candidate, "LICENSE"), original.LICENSE);
  rmSync(join(target, "LICENSE"));
  symlinkSync(outside, join(target, "LICENSE"));
  assert.throws(() => applyRtkCandidate(candidate, repo), /regular files/);
  assert.deepEqual(readFileSync(outside), original.LICENSE);
});

test("preparation rejects downgrades and same-version provenance drift", (t) => {
  const { candidate, target } = fixture(t);
  validatePreparedCandidate(candidate, target);
  metadataAt(candidate, (metadata) => { metadata.commit = "a".repeat(40); });
  assert.throws(() => validatePreparedCandidate(candidate, target), /same-version/);
  metadataAt(candidate, (metadata) => { metadata.version = "0.0.0"; metadata.tag = "v0.0.0"; });
  assert.throws(() => validatePreparedCandidate(candidate, target), /must not downgrade/);
  metadataAt(candidate, (metadata) => { metadata.version = "99.0.0"; metadata.tag = "v99.0.0"; });
  assert.equal(validatePreparedCandidate(candidate, target).version, "99.0.0");
});

test("RTK versions compare numerically and reject malformed input", () => {
  assert.equal(compareRtkVersions("1.10.0", "1.9.99"), 1);
  assert.equal(compareRtkVersions("2.0.0", "10.0.0"), -1);
  assert.equal(compareRtkVersions("1.0.0", "1.0.0"), 0);
  for (const version of ["v1.0.0", "1.0.0-rc1", "01.0.0", "1.0.0; echo unsafe"]) {
    assert.throws(() => compareRtkVersions(version, "1.0.0"));
  }
});

function setup() {
  return {
    user: { login: "fixture-owner" },
    repository: { allow_auto_merge: true, allow_squash_merge: true, delete_branch_on_merge: true },
    rules: [
      { type: "pull_request", parameters: { required_approving_review_count: 0 } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: requiredChecks.map((context) => ({ context, integration_id: 15368 })) } },
    ],
  };
}

test("publication preflight requires identity, auto-merge, deletion, and each CI gate", () => {
  const good = setup();
  validateRenovateSetup(good.user, good.repository, good.rules, "fixture-owner");
  assert.throws(() => validateRenovateSetup(good.user, good.repository, good.rules, ""), /PAT owner/);
  assert.throws(() => validateRenovateSetup(good.user, good.repository, good.rules, "another-owner"), /does not belong/);
  for (const key of Object.keys(good.repository)) {
    assert.throws(() => validateRenovateSetup(good.user, { ...good.repository, [key]: false }, good.rules, "fixture-owner"));
  }
  for (let index = 0; index < requiredChecks.length; index++) {
    const altered = setup();
    altered.rules[1].parameters.required_status_checks.splice(index, 1);
    assert.throws(() => validateRenovateSetup(altered.user, altered.repository, altered.rules, "fixture-owner"), /require GitHub Actions check/);
  }
  const altered = setup();
  altered.rules[1].parameters.required_status_checks[0].integration_id = null;
  assert.throws(() => validateRenovateSetup(altered.user, altered.repository, altered.rules, "fixture-owner"), /require GitHub Actions check/);
  const stale = setup();
  stale.rules[1].parameters.strict_required_status_checks_policy = false;
  assert.throws(() => validateRenovateSetup(stale.user, stale.repository, stale.rules, "fixture-owner"), /up to date/);
  const reviewed = setup();
  reviewed.rules[0].parameters.required_approving_review_count = 1;
  assert.throws(() => validateRenovateSetup(reviewed.user, reviewed.repository, reviewed.rules, "fixture-owner"), /human reviews/);
});

test("required Linux gate covers every same-repo Renovate branch and rejects unexpected branches", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const gate = workflowStep(ci, "Validate automatic update before allowing merge");
  const condition = stepCondition(gate);
  assert.ok(condition);
  const repository = "owner/repo", actor = "updater", headSha = "a".repeat(40);
  const shouldRun = (ref, { os = "linux", headRepository = repository, event = "pull_request" } = {}) => runInNewContext(condition, {
    matrix: { os },
    github: { event_name: event, repository, event: { pull_request: { head: { ref, repo: { full_name: headRepository } } } } },
    startsWith: (value, prefix) => value.toLowerCase().startsWith(prefix.toLowerCase()),
  });
  const files = ["package.json", "package-lock.json"].map((filename) => ({ filename, status: "modified" }));
  for (const ref of ["renovate/dependencies", "renovate/npm-example-vulnerability", "renovate/unexpected"]) {
    assert.equal(shouldRun(ref), true, `${ref} must not skip required authorization`);
    const pr = {
      merged: false, base: { ref: "master", repo: { full_name: repository } },
      head: { ref, sha: headSha, repo: { full_name: repository } },
      user: { login: actor }, labels: [{ name: "auto-release:dependencies" }], changed_files: files.length,
    };
    if (ref === "renovate/dependencies") {
      assert.equal(authorizePendingUpdate(pr, files, { repository, actor, headSha }).updateClass, "npm");
    } else {
      assert.throws(() => authorizePendingUpdate(pr, files, { repository, actor, headSha }), /exact grouped Renovate branch/);
    }
  }
  assert.equal(shouldRun("renovate/dependencies", { os: "windows" }), false);
  assert.equal(shouldRun("renovate/dependencies", { headRepository: "fork/repo" }), false);
  assert.equal(shouldRun("renovate/dependencies", { event: "push" }), false);
  assert.equal(shouldRun("feature/change"), false);
  assert.equal(shouldRun("renovate-other/change"), false);
  assert.ok(requiredChecks.includes("test-linux-x64"));
  assert.match(gate, /node .*validate-auto-update\.mjs" --pending/);
});

test("RTK preparation verifies first, validates only changed candidates, and always uploads", () => {
  const verify = workflowStep(workflow, "Verify candidate data");
  const validate = workflowStep(workflow, "Validate generated package");
  const upload = workflowStep(workflow, "Upload candidate from this run");
  assert.match(verify, /id: candidate/);
  assert.ok(workflow.indexOf("name: Verify candidate data") < workflow.indexOf("name: Validate generated package"));
  assert.ok(workflow.indexOf("name: Validate generated package") < workflow.indexOf("name: Upload candidate from this run"));
  assert.equal(stepCondition(validate), "steps.candidate.outputs.changed == 'true'");
  assert.equal(stepCondition(upload), undefined, "unchanged candidates must still be uploaded");
});

test("Linux preparation script reports unchanged/changed and fails before output on invalid candidates", { skip: process.platform !== "linux" }, (t) => {
  const { root, repo, target } = fixture(t);
  mkdirSync(join(repo, "scripts"));
  copyFileSync(new URL("../../scripts/rtk-candidate.mjs", import.meta.url), join(repo, "scripts/rtk-candidate.mjs"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Preparation test");
  git("config", "user.email", "preparation@example.invalid");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(root, "no-hooks"));
  git("add", "--all");
  git("commit", "--quiet", "-m", "test: preparation baseline");
  const base = git("rev-parse", "HEAD");
  const runnerTemp = join(root, "runner temp"), output = join(root, "step-output");
  mkdirSync(runnerTemp);
  const script = workflowStep(workflow, "Verify candidate data").split("        run: |\n")[1]
    .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
  const run = () => {
    writeFileSync(output, "");
    return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, BASE_SHA: base, RTK_CANDIDATE_DIR: target, RTK_BASE_DIR: join(runnerTemp, "rtk-base/vendor/pi-rtk"), RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output },
    });
  };
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "changed=false\n");
  metadataAt(target, (metadata) => { metadata.version = "99.0.0"; metadata.tag = "v99.0.0"; });
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "changed=true\n");
  writeFileSync(join(target, "index.ts"), "corrupt source");
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source hash mismatch/);
  assert.equal(readFileSync(output, "utf8"), "");
  writeFileSync(join(target, "index.ts"), original["index.ts"]);
  writeFileSync(join(target, "metadata.json"), original["metadata.json"]);
  metadataAt(target, (metadata) => { metadata.commit = "a".repeat(40); });
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same-version/);
  assert.equal(readFileSync(output, "utf8"), "");
});

test("Renovate policy groups npm and RTK, disables dashboard, and gates auto-merge", () => {
  assert.deepEqual(policy.enabledManagers, ["npm", "custom.regex"]);
  assert.equal(policy.dependencyDashboard, false);
  assert.equal(policy.vulnerabilityAlerts?.enabled, false);
  assert.equal(policy.automerge, true);
  assert.equal(policy.automergeType, "pr");
  assert.equal(policy.platformAutomerge, true);
  assert.equal(policy.ignoreTests, false);
  assert.equal(policy.branchPrefix + policy.branchTopic, "renovate/dependencies");
  const manager = policy.customManagers[0];
  const match = new RegExp(manager.matchStrings[0]).exec(original["metadata.json"].toString());
  assert.equal(match.groups.currentValue, JSON.parse(original["metadata.json"]).version);
  assert.equal(manager.datasourceTemplate, "github-releases");
});

test("global config only permits copying the prepared version with fixed tooling", () => {
  const source = readFileSync(new URL("../../.github/renovate.config.cjs", import.meta.url), "utf8");
  const require = createRequire(import.meta.url);
  const context = {
    module: { exports: {} },
    process: { env: { RTK_CANDIDATE_DIR: "/candidate" } },
    require: (name) => name === "node:fs" ? { readFileSync: (path) => path.endsWith("metadata.json") ? JSON.stringify({ version: "1.2.3" }) : JSON.stringify(policy) } : require(name),
  };
  runInNewContext(source, context);
  const config = context.module.exports;
  assert.equal(config.allowScripts, false);
  assert.equal(config.allowPlugins, false);
  assert.equal(config.customEnvVariables.RTK_CANDIDATE_DIR, "/opt/rtk-candidate");
  assert.equal(config.exposeAllEnv, undefined);
  assert.equal(config.requireConfig, "ignored");
  assert.equal(config.vulnerabilityAlerts?.enabled, false);
  const rule = config.packageRules.at(-1);
  assert.equal(rule.allowedVersions, "1.2.3");
  assert.equal(rule.postUpgradeTasks.executionMode, "update");
  const command = rule.postUpgradeTasks.commands[0];
  assert.ok(new RegExp(config.allowedCommands[0]).test(command));
  assert.equal(new RegExp(config.allowedCommands[0]).test(command + "; echo unsafe"), false);
});

test("workflow is scheduled/manual-only and separates RTK execution from the PAT", () => {
  const triggers = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
  assert.match(triggers, /workflow_dispatch:/);
  assert.match(triggers, /schedule:/);
  assert.doesNotMatch(triggers, /push:|pull_request:|issues:|issue_comment:|workflow_run:/);
  const prepare = workflow.slice(workflow.indexOf("  prepare:"), workflow.indexOf("  renovate:"));
  const publisher = workflow.slice(workflow.indexOf("  renovate:"));
  assert.doesNotMatch(prepare, /secrets\./);
  assert.match(prepare, /node scripts\/update-pi-rtk\.mjs/);
  assert.doesNotMatch(publisher, /run:.*(?:npm|update-pi-rtk|rtk init)/);
  assert.match(publisher, /mount-docker-socket: false/);
  assert.match(publisher, /\/opt\/rtk-candidate:ro/);
  assert.match(publisher, /secrets\.RENOVATE_PAT/);
  assert.doesNotMatch(publisher, /token:.*github\.token|contents: write/);
});
