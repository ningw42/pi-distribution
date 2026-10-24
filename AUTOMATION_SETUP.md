# Automation setup

Renovate is self-managed in GitHub Actions, using standard GitHub-hosted Linux runners. Mend's hosted App is not part of this setup. All dependency updates, including generated `pi-rtk`, share one PR; required cross-platform CI gates automatic squash merging and GitHub deletes the merged source branch.

## Event flow and credential boundaries

```text
renovate.yml: schedule / manual dispatch (master only)
  |
  +-- prepare: read-only GITHUB_TOKEN
  |     download RTK release + verify checksum
  |     generate source + verify upstream source/license/provenance
  |     run package/runtime/smoke validation
  |     upload the three generated files (one-day retention)
  |
  +-- renovate: dedicated RENOVATE_PAT
        verify PAT identity and repository merge gates
        scan npm dependencies + RTK GitHub releases
        copy the verified RTK candidate when RTK changes
        create/update renovate/dependencies + request auto-merge
          |
          +-- required Linux x64 / Windows x64 / Windows ARM64 CI
                |
                +-- automatic squash merge + source branch deletion
                      |
                      +-- validate update -> RELEASE_PAT pushes CalVer tag
                            |
                            +-- tag-only release workflow
                                  |
                                  +-- KURA_WORKFLOW_PAT dispatches Kura updater
```

The schedule is every four hours at minute 23 UTC. `workflow_dispatch` supplies the on-demand **Actions → Renovate → Run workflow** button. There are no issue, PR, push, or webhook triggers for Renovate. Scheduled jobs are best-effort, not exact-time delivery; GitHub can disable schedules in inactive public repositories. Both triggers require `master` and the repository variable `RENOVATE_ENABLED=true`.

`renovate.json5` owns grouping and update policy. The trusted global configuration, `.github/renovate.config.cjs`, fixes that policy to the workflow snapshot and permits only a copy-only post-upgrade command. Its RTK version constraint is the version prepared in the same run: an upstream release arriving mid-run cannot be selected without its artifacts. Preparation failure stops publication, including npm updates; rerun the workflow after resolving it.

The generator, downloaded RTK executable, dependency tests, and smoke tests never receive the publication or release PAT. The publisher disables npm lifecycle scripts and plugins, does not mount the Docker socket, and mounts its trusted helper and candidate read-only. It does not execute code from the generated files. Final PR CI tests the combined npm/RTK result on all three platforms.

## 1. Remove the old automation before cutover

1. Open <https://github.com/settings/installations> and configure the official **Renovate** / Mend App.
2. Remove access to `ningw42/pi-distribution`. If this is the installation's only repository and the App is no longer wanted, uninstall it. Do not remove access to unrelated repositories unintentionally.
3. Close the old [Dependency Dashboard issue #3](https://github.com/ningw42/pi-distribution/issues/3). If Mend recreated it before its access was removed, close it again afterward.
4. Finish or close any outstanding `renovate/npm-*` or `auto-update/pi-rtk-*` PRs before switching. The new release authorizer intentionally does not trust those legacy branches.

The old `update_pi_rtk.yml` is removed by this migration. The new configuration has `dependencyDashboard=false`; no dashboard or checkbox trigger is created. Leave `RENOVATE_ENABLED` unset or `false` until the remaining setup is complete. Do not leave Mend and this workflow updating the same repository concurrently.

## 2. Create the dedicated publication PAT

1. Open <https://github.com/settings/personal-access-tokens/new>.
2. Create a fine-grained token named `pi-distribution Renovate` under the intended updater account.
3. Restrict repository access to **Only select repositories → pi-distribution**.
4. Grant **Contents**, **Pull requests**, **Issues**, and **Commit statuses**: **Read and write**. Grant **Administration** and **Dependabot alerts**: **Read-only**, for branch-rule inspection and vulnerability information. Do not look for **Checks**: it is listed for GitHub App authentication, not in Renovate's [fine-grained PAT permissions](https://docs.renovatebot.com/modules/platform/github/#permissions). Metadata read access is automatic. This personal repository needs no organization Members permission. The configured managers do not update workflow files, so no Workflows write permission is needed.
5. Set an expiration and arrange rotation. Generate and copy the token.
6. Store it using the hidden interactive prompt; never put it in a file, command argument, PR, or chat:

   ```bash
   gh secret set RENOVATE_PAT --repo ningw42/pi-distribution
   ```

7. Set the public variable `RENOVATE_ACTOR` to the token owner's exact GitHub login, for example:

   ```bash
   gh variable set RENOVATE_ACTOR --repo ningw42/pi-distribution --body ningw42
   ```

There is no fallback to `GITHUB_TOKEN`. PAT-created PRs start CI without GitHub's approval gate for workflow-token-created PRs. A PAT does not bypass branch rules or approve its own author's code reviews. Fully unattended merging requires no mandatory human review, while retaining the mandatory CI checks below.

This token is separate from `RELEASE_PAT` and `KURA_WORKFLOW_PAT`. A repository-scoped PAT is not inherently restricted to one workflow: protect workflow changes and never run untrusted generators/tests in the PAT-bearing job. New PRs are authored by `RENOVATE_ACTOR`; the release tagger checks that identity, the exact branch, label, paths, and update semantics twice.

## 3. Configure repository settings and mandatory CI

In <https://github.com/ningw42/pi-distribution/settings>, enable:

- **Allow squash merging**;
- **Allow auto-merge**;
- **Automatically delete head branches**.

Equivalent CLI:

```bash
gh repo edit ningw42/pi-distribution \
  --enable-auto-merge --delete-branch-on-merge --enable-squash-merge
```

In <https://github.com/ningw42/pi-distribution/settings/rules>, create an **active branch ruleset** targeting `master` that:

- requires a pull request, with zero required approving reviews;
- requires `test-linux-x64`, `test-windows-x64`, and `test-windows-arm64`, each from the **GitHub Actions** integration;
- requires the branch to be up to date before merging;
- blocks force pushes and branch deletion;
- gives no bypass to the updater identity.

Auto-merge alone is not a CI gate. `scripts/check-renovate-setup.mjs` fails publication if the PAT identity, auto-merge, deletion, PR requirement, or required checks are missing. The three job names are stable outputs of `ci.yml`. If needed, run ordinary PR CI once to make them selectable in GitHub's UI.

Keep the default `GITHUB_TOKEN` permission **Read repository contents and packages** in <https://github.com/ningw42/pi-distribution/settings/actions>. The Renovate jobs request no writable workflow-token permissions.

Create the classification label idempotently:

```bash
gh label create auto-release:dependencies --repo ningw42/pi-distribution \
  --color 0e8a16 --description "Validated Renovate dependency updates create a release" --force
```

## 4. Preserve release tagging credentials and tag protection

`RELEASE_PAT` is a separate fine-grained token restricted to `pi-distribution`, with **Contents: Read and write**. It is used only in the post-validation tag job. A tag pushed with `GITHUB_TOKEN` would not start the tag-only publisher.

If not already configured, create it at <https://github.com/settings/personal-access-tokens/new>, then store it privately:

```bash
gh secret set RELEASE_PAT --repo ningw42/pi-distribution
```

Rotate before expiry. Protect release tags with an active tag ruleset targeting `v*.*.*` that blocks updates and deletion but permits new tags. Retain an audited administrator recovery path. Do not block normal tag creation by the token owner.

Each required platform CI job validates pending `renovate/dependencies` PRs using the authorizer from the trusted base revision, before executing the package tests. This rejects malformed update PRs before auto-merge, not only after release tagging starts.

The tagger accepts only `renovate/dependencies` PRs by `RENOVATE_ACTOR` carrying `auto-release:dependencies`. It accepts npm-only, RTK-only, or mixed updates, but rejects unrelated paths, unpaired manifest/lock changes, non-regular files, changed package metadata, and incoherent or non-advancing RTK provenance. Both authorization steps use tooling from the merged commit's first parent; the PAT-bearing step never executes the update's code. The CalVer allocator and tag-only publication path remain unchanged.

## 5. Enable and verify after merging the migration

After the migration PR passes CI and is merged, and Mend's access is removed:

```bash
gh variable set RENOVATE_ENABLED --repo ningw42/pi-distribution --body true
gh workflow run renovate.yml --repo ningw42/pi-distribution --ref master
```

Verify:

1. RTK preparation and Renovate publication succeed; a no-change run opens no PR.
2. An available update creates `renovate/dependencies` with label `auto-release:dependencies` and requests auto-merge. All update types, including majors, currently share this policy.
3. The PR changes only the root manifest/lock pair, smoke-runtime manifest/lock pair, and/or the three `vendor/pi-rtk/` files.
4. All three required platform checks run automatically. If any fail, the PR remains open. When the branch is current and all requirements pass, GitHub squash-merges it and deletes the source branch.
5. `tag_on_auto_update_merge.yml` validates the update and creates the next `vYY.MM.N` annotated tag.
6. `build_and_publish_release.yml` validates Ubuntu and native Windows x64/ARM64 artifacts, then publishes generated release notes, both `.tgz` assets, and SHA-256 checksums.

Renovate itself and its action are pinned in `renovate.yml`. Update those pins manually in a reviewed PR and rerun the full gate. The configured managers deliberately do not mutate workflow files.

To pause updates, set `RENOVATE_ENABLED=false`. To roll back, restore the former workflows/configuration in a reviewed PR before re-enabling Mend. Do not run both publishers during recovery. Already merged dependency changes and published releases are not undone by pausing automation.

## Manual releases

A maintainer can release any intentionally selected commit:

```bash
git tag -a v26.08.0 <commit> -m "pi-distribution v26.08.0"
git push origin v26.08.0
```

The tag enters the same publisher. It must match `vYY.MM.N`, and the tagged package must pass Ubuntu validation and native Windows x64/ARM64 packed-artifact smoke tests.

## Kura update dispatch credential

After a successful release including asset uploads, `trigger-kura-update` dispatches `ningw42/kura`'s `auto-update-packages.yml` on `master`. It starts the full package updater asynchronously; publication does not wait for Kura's result.

The built-in `GITHUB_TOKEN` cannot dispatch in Kura. `KURA_WORKFLOW_PAT` must be a separate fine-grained token restricted to **kura**, with **Actions: Read and write**, stored as a secret in **pi-distribution**:

```bash
gh secret set KURA_WORKFLOW_PAT --repo ningw42/pi-distribution
```

It is separate from Kura's own `AUTO_UPDATE_PAT`, which publishes Kura update PRs. There is no `GITHUB_TOKEN` fallback. A missing/expired credential fails dispatch after the release is published; fix it and rerun the failed job. Kura may update other packages too, and a no-change run opens no PR. Its twice-daily schedule remains a fallback.

## Troubleshooting

- **Renovate is skipped:** confirm the workflow is on `master` and `RENOVATE_ENABLED=true`.
- **Publication preflight fails:** check `RENOVATE_PAT`, its expiry/permissions, `RENOVATE_ACTOR`, auto-merge/deletion settings, and the active required-check ruleset. Never bypass checks to unblock an update.
- **RTK preparation fails:** inspect release download/checksum, upstream source comparison, and package/smoke validation logs. Publication stops rather than shipping an incomplete candidate.
- **PR CI needs manual workflow approval:** the PR was likely created with `GITHUB_TOKEN` rather than the dedicated PAT.
- **PR does not merge:** inspect failing/missing required checks, branch freshness, merge conflicts, requested human reviews, or disabled auto-merge. Renovate rebases on its next run; use manual dispatch to request one now.
- **Merged update produced no tag:** inspect both authorizations and `RELEASE_PAT`; legacy bot authors/branches and unrelated changes are deliberately rejected.
- **Tag produced no release run:** confirm the tag was pushed with the separate valid `RELEASE_PAT`, not `GITHUB_TOKEN`. Do not add a second commit- or PR-triggered publication path.
- **Dashboard reappears:** remove the remaining Mend installation access and close the legacy issue again. Actions-owned Renovate disables the dashboard.
