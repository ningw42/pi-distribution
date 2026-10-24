const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// These files are mounted read-only from this workflow run, not loaded from
// Renovate's mutable repository checkout. The candidate was verified in a
// separate job without the PAT; changed candidates also passed package tests.
const candidate = JSON.parse(readFileSync(join(process.env.RTK_CANDIDATE_DIR, "metadata.json"), "utf8"));
assert.match(candidate.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const policy = JSON.parse(readFileSync("/opt/renovate-tools/renovate.json5", "utf8"));
delete policy.$schema;

module.exports = {
  ...policy,
  platform: "github",
  repositories: ["ningw42/pi-distribution"],
  onboarding: false,
  // The policy above is already loaded from the trusted workflow snapshot.
  // Do not merge a second, possibly newer repository configuration over it.
  requireConfig: "ignored",
  allowScripts: false,
  allowPlugins: false,
  // Renovate separately filters the environment passed to post-upgrade tools.
  customEnvVariables: { RTK_CANDIDATE_DIR: "/opt/rtk-candidate" },
  allowedCommands: ["^node /opt/renovate-tools/rtk-candidate\\.mjs$"],
  ignoreScripts: true,
  // A later upstream release cannot be selected before its artifacts are ready.
  packageRules: [
    ...policy.packageRules,
    {
      matchManagers: ["custom.regex"],
      matchPackageNames: ["rtk-ai/rtk"],
      allowedVersions: candidate.version,
      postUpgradeTasks: {
        commands: ["node /opt/renovate-tools/rtk-candidate.mjs"],
        fileFilters: ["vendor/pi-rtk/LICENSE", "vendor/pi-rtk/index.ts", "vendor/pi-rtk/metadata.json"],
        // Branch-mode tasks can be lost when npm is the group's first upgrade.
        executionMode: "update",
      },
    },
  ],
};
