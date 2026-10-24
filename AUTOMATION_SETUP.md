# Automation setup

This guide configures the repository's automation from scratch. Renovate runs in GitHub Actions on standard GitHub-hosted Linux runners. Exact npm and generated `pi-rtk` updates share one PR; required cross-platform CI gates automatic squash merging, and GitHub deletes the merged source branch.

## Event flow and credential boundaries

```text
renovate.yml: schedule / manual dispatch (master only)
  |
  +-- prepare: read-only GITHUB_TOKEN
  |     download RTK release + verify checksum
  |     generate source + verify upstream source/license/provenance
  |     verify candidate against the base snapshot
  |     run package/runtime/smoke validation only if changed
  |     upload all three files, changed or unchanged (one-day retention)
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

Renovate runs every four hours at 00:00, 04:00, 08:00, 12:00, 16:00, and 20:00 UTC. `workflow_dispatch` supplies **Actions → Renovate → Run workflow** for on-demand runs. These are its only triggers; the Dependency Dashboard is disabled. Scheduled jobs are best-effort, not exact-time delivery, and GitHub can disable schedules in inactive public repositories. Both triggers require `master` and `RENOVATE_ENABLED=true`.

`renovate.json5` owns grouping and update policy. `.github/renovate.config.cjs` loads that policy from the trusted workflow snapshot and permits only a copy-only post-upgrade command. The RTK version constraint is the version prepared in the same run: an upstream release arriving mid-run cannot be selected without its artifacts. Candidate integrity and its comparison with the base snapshot are always verified first. A byte-identical candidate skips dependency installation and package/runtime/smoke validation; a changed candidate must pass that full suite. The artifact is uploaded in either case. Invalid candidates or failed validation stop publication, including npm updates; rerun after resolving the failure.

Renovate vulnerability-alert PRs are explicitly disabled so they cannot bypass the validated group with separate branches or lockfile-only remediation. Regular version updates can still contain security fixes. This policy does not change GitHub's own alert settings, and the publication PAT does not need Dependabot alerts access.

The generator, downloaded RTK executable, dependency tests, and smoke tests never receive the publication or release PAT. The publisher disables npm lifecycle scripts and plugins, does not mount the Docker socket, and mounts its trusted helper and candidate read-only. It does not execute generated source. Final PR CI tests the combined npm/RTK result on all three platforms.

## Prerequisites

- The repository's workflows and configuration files are present on `master`.
- GitHub Actions is enabled for the repository.
- You have repository administration rights and an authenticated GitHub CLI for the commands below. Browser links provide the equivalent settings pages.

Keep updates paused while configuring credentials and merge gates:

```bash
gh variable set RENOVATE_ENABLED --repo ningw42/pi-distribution --body false
```

## 1. Configure the Renovate publication credential

1. Open <https://github.com/settings/personal-access-tokens/new>.
2. Create a fine-grained token named `pi-distribution Renovate` under the intended updater account.
3. Restrict repository access to **Only select repositories → pi-distribution**.
4. Grant these repository permissions:

   | Access | Permissions |
   |---|---|
   | Read and write | Contents, Pull requests, Issues, Commit statuses |
   | Read-only | Administration |
   | Automatic read access | Metadata |

   The configured managers do not update workflow files, so no Workflows write permission is needed. This personal repository needs no organization Members permission. See Renovate's [fine-grained PAT permissions](https://docs.renovatebot.com/modules/platform/github/#permissions).

5. Set an expiration and arrange rotation. Generate and copy the token.
6. Store it using the hidden interactive prompt; never put it in a file, command argument, PR, or chat:

   ```bash
   gh secret set RENOVATE_PAT --repo ningw42/pi-distribution
   ```

7. Set `RENOVATE_ACTOR` to the token owner's exact GitHub login, for example:

   ```bash
   gh variable set RENOVATE_ACTOR --repo ningw42/pi-distribution --body ningw42
   ```

There is no fallback to `GITHUB_TOKEN`. PAT-created PRs start CI without GitHub's approval gate for workflow-token-created PRs. A PAT does not bypass branch rules or approve its own author's code reviews. Fully unattended merging requires no mandatory human review, while retaining mandatory CI.

This token is separate from `RELEASE_PAT` and `KURA_WORKFLOW_PAT`. A repository-scoped PAT is not restricted to one workflow: protect workflow changes and never run untrusted generators/tests in the PAT-bearing job. PRs are authored by `RENOVATE_ACTOR`; the release tagger checks that identity, branch, label, paths, and update semantics twice.

## 2. Configure repository settings and mandatory CI

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
- requires conversations to be resolved before merging;
- requires `test-linux-x64`, `test-windows-x64`, and `test-windows-arm64`, each from the **GitHub Actions** integration;
- requires the branch to be up to date before merging;
- blocks force pushes and branch deletion;
- has no bypass actors.

Auto-merge alone is not a CI gate. `scripts/check-renovate-setup.mjs` fails publication if the PAT identity, auto-merge, deletion, PR requirement, or required checks are missing. The three job names are stable outputs of `ci.yml`. Run ordinary PR CI once if needed to make them selectable in GitHub's UI.

Keep the default `GITHUB_TOKEN` permission **Read repository contents and packages** in <https://github.com/ningw42/pi-distribution/settings/actions>. Renovate jobs request no writable workflow-token permissions.

Create the classification label:

```bash
gh label create auto-release:dependencies --repo ningw42/pi-distribution \
  --color 0e8a16 --description "Validated Renovate dependency updates create a release" --force
```

## 3. Configure release tagging

Create a separate fine-grained token named `pi-distribution release tagger` at <https://github.com/settings/personal-access-tokens/new>. Restrict it to **pi-distribution**, grant **Contents: Read and write**, set an expiration, and store it privately:

```bash
gh secret set RELEASE_PAT --repo ningw42/pi-distribution
```

It is used only in the post-validation tag job. A tag pushed with `GITHUB_TOKEN` would not start the tag-only publisher. Rotate the PAT before expiry.

Create an **active tag ruleset** targeting `v*.*.*` that blocks tag updates and deletion, permits new tags, and has no bypass actors. Administrators can edit the ruleset for an audited recovery operation; ordinary automation must not rewrite published tags.

The required `test-linux-x64` CI job runs the trusted base-revision authorizer for every same-repository PR whose branch starts with `renovate/`. The authorizer accepts only valid `renovate/dependencies` updates and rejects every unexpected branch, identity, path, or semantic change before auto-merge. Windows x64 and ARM64 remain required and run the full package/runtime/smoke suite without duplicating the Linux authorization shell step.

The tagger accepts only `renovate/dependencies` PRs by `RENOVATE_ACTOR` carrying `auto-release:dependencies`. It accepts npm-only, RTK-only, or mixed updates, but rejects unrelated paths, unpaired manifest/lock changes, non-regular files, changed package metadata, and incoherent or non-advancing RTK provenance. Both authorization steps use tooling from the merged commit's first parent; the PAT-bearing step never executes the update's code. Successful validation creates the next `vYY.MM.N` annotated tag, which starts release publication.

## 4. Configure the Kura update dispatch

After a successful release including asset uploads, `trigger-kura-update` dispatches `ningw42/kura`'s `auto-update-packages.yml` on `master`. It starts the full package updater asynchronously; publication does not wait for Kura's result.

Create a separate fine-grained token restricted to **kura**, with **Actions: Read and write**, and store it as `KURA_WORKFLOW_PAT` in **pi-distribution**:

```bash
gh secret set KURA_WORKFLOW_PAT --repo ningw42/pi-distribution
```

The built-in `GITHUB_TOKEN` cannot dispatch in Kura. There is no fallback. `KURA_WORKFLOW_PAT` is separate from Kura's own `AUTO_UPDATE_PAT`, which publishes Kura update PRs. Rotate before expiry. A missing/expired credential fails dispatch after the release is published; fix it and rerun the failed job.

Kura may update other packages too, and a no-change run opens no PR. Its twice-daily schedule remains a fallback.

## 5. Enable and verify

After configuring all three secrets, the actor variable, and the repository rules:

```bash
gh variable set RENOVATE_ENABLED --repo ningw42/pi-distribution --body true
gh workflow run renovate.yml --repo ningw42/pi-distribution --ref master
```

Verify:

1. RTK preparation and Renovate publication succeed; a no-change run opens no PR.
2. An available update creates `renovate/dependencies` with label `auto-release:dependencies` and requests auto-merge. All regular version updates, including majors, share this policy.
3. The PR changes only the root manifest/lock pair, smoke-runtime manifest/lock pair, and/or the three `vendor/pi-rtk/` files.
4. All three required platform checks run automatically. A failed check leaves the PR open. When the branch is current and all requirements pass, GitHub squash-merges it and deletes the source branch.
5. `tag_on_auto_update_merge.yml` validates the update and creates a release tag.
6. `build_and_publish_release.yml` validates Ubuntu and native Windows x64/ARM64 artifacts, then publishes generated release notes, both `.tgz` assets, and SHA-256 checksums.
7. A successful release is followed by an **Auto-update packages** run in Kura.

## Routine operation

- **Run now:** use **Actions → Renovate → Run workflow**, selecting `master`, or use the dispatch command above.
- **Pause/resume:** set `RENOVATE_ENABLED` to `false`/`true`. Pausing prevents new updater runs; cancel an already-running job or disable auto-merge on an open PR separately if needed. It does not undo merged changes or published releases.
- **Rotate credentials:** replace the corresponding repository secret before expiry and verify its next use. Never substitute one PAT for another.
- **Update Renovate:** its CLI and action versions are pinned in `renovate.yml`. Change those pins in a reviewed PR and run the full verification gate. The configured managers deliberately do not mutate workflow files.

## Manual releases

A maintainer can release any intentionally selected commit:

```bash
git tag -a v26.08.0 <commit> -m "pi-distribution v26.08.0"
git push origin v26.08.0
```

The tag must match `vYY.MM.N`. It enters the same publisher and must pass Ubuntu validation and native Windows x64/ARM64 packed-artifact smoke tests.

## Troubleshooting

- **Renovate is skipped:** confirm the workflow is on `master` and `RENOVATE_ENABLED=true`.
- **Publication preflight fails:** check `RENOVATE_PAT`, its expiry/permissions, `RENOVATE_ACTOR`, auto-merge/deletion settings, and the active required-check ruleset. Never bypass checks to unblock an update.
- **RTK preparation fails:** inspect release download/checksum, upstream source/base comparison, and, for changed candidates, package/smoke validation logs. Publication stops rather than shipping an incomplete candidate.
- **PR CI needs manual workflow approval:** check that the PR was created with the dedicated PAT rather than `GITHUB_TOKEN`.
- **PR does not merge:** inspect failing/missing required checks, branch freshness, merge conflicts, unresolved conversations, requested human reviews, or disabled auto-merge. Renovate rebases on its next run; use manual dispatch to request one now.
- **Merged update produced no tag:** inspect both authorizations, the PR identity/branch/label, allowed file changes, and `RELEASE_PAT`.
- **Tag produced no release run:** confirm the tag was pushed with the valid `RELEASE_PAT`, not `GITHUB_TOKEN`. Publication is triggered only by tag pushes.
