import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredChecks = ["test-linux-x64", "test-windows-x64", "test-windows-arm64"];

export function validateRenovateSetup(user, repository, rules, actor) {
  assert.match(actor ?? "", /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/, "RENOVATE_ACTOR must name the PAT owner");
  assert.equal(user.login, actor, "RENOVATE_PAT does not belong to RENOVATE_ACTOR");
  assert.equal(repository.allow_auto_merge, true, "enable repository auto-merge");
  assert.equal(repository.allow_squash_merge, true, "enable squash merging");
  assert.equal(repository.delete_branch_on_merge, true, "enable automatic source branch deletion");
  const checks = rules.filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters.required_status_checks);
  for (const context of requiredChecks) {
    assert.ok(checks.some((check) => check.context === context && check.integration_id === 15368), `require GitHub Actions check: ${context}`);
  }
  assert.ok(rules.some((rule) => rule.type === "required_status_checks" && rule.parameters.strict_required_status_checks_policy === true), "require branches to be up to date before merging");
  assert.ok(rules.some((rule) => rule.type === "pull_request"), "require pull requests on master");
  for (const rule of rules.filter((rule) => rule.type === "pull_request")) {
    assert.equal(rule.parameters.required_approving_review_count, 0, "fully automatic updates cannot require human reviews");
  }
}

async function main() {
  const token = process.env.RENOVATE_TOKEN;
  assert.ok(token, "set the dedicated RENOVATE_PAT repository secret; there is no GITHUB_TOKEN fallback");
  const repository = process.env.REPOSITORY;
  assert.equal(repository, "ningw42/pi-distribution");
  const get = async (path) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `GitHub setup check failed for ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const [user, repo, rules] = await Promise.all([
    get("user"), get(`repos/${repository}`), get(`repos/${repository}/rules/branches/master`),
  ]);
  validateRenovateSetup(user, repo, rules, process.env.RENOVATE_ACTOR);
  console.log("Renovate identity, auto-merge, branch deletion, and required CI checks verified");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
