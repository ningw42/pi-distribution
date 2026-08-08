# Automation setup

This repository uses separate automation paths for npm dependency updates, generated `pi-rtk` updates, automatic release tagging, and GitHub Release publication. Complete this one-time GitHub setup after the automation files have been pushed to `master`.

## Event flow

```text
Renovate App -> npm update PR ------------------------┐
                                                      |-> merge -> automatic CalVer tag --┐
update_pi_rtk.yml -> generated pi-rtk update PR ------┘                                    |
                                                                                           |-> tag-only release workflow
Human pushes a vYY.MM.N tag ---------------------------------------------------------------┘
```

The publisher reacts only to tag pushes. Automatic tag pushes must use a non-`GITHUB_TOKEN` credential so GitHub starts the downstream release workflow.

## 1. Install the Renovate GitHub App

1. Open <https://github.com/apps/renovate/installations/new>.
2. Choose the account that owns `ningw42/pi-distribution`.
3. Select **Only select repositories** and grant access to `pi-distribution`.
4. Review the requested permissions and install the App.

[`renovate.json5`](renovate.json5) is already the reviewed repository configuration. It groups all available exact, direct npm dependency updates into one PR, with no automerge. Installing the App activates that configuration; no Renovate workflow runs in GitHub Actions.

## 2. Ensure the classification labels exist

The automatic tagger requires these labels:

- `auto-release:npm`
- `auto-release:pi-rtk`

Create them through the GitHub UI or idempotently with:

```bash
gh label create auto-release:npm \
  --repo ningw42/pi-distribution \
  --color 0e8a16 \
  --description "Merged npm dependency updates create a release tag" \
  --force

gh label create auto-release:pi-rtk \
  --repo ningw42/pi-distribution \
  --color 1d76db \
  --description "Merged generated pi-rtk updates create a release tag" \
  --force
```

Renovate applies the npm label through `renovate.json5`; `update_pi_rtk.yml` applies the generated-artifact label.

## 3. Configure GitHub Actions permissions

Open <https://github.com/ningw42/pi-distribution/settings/actions> and configure **Workflow permissions**:

1. Keep the default token permission at **Read repository contents and packages**.
2. Enable **Allow GitHub Actions to create and approve pull requests** so `update_pi_rtk.yml` can open its update PR.

Each write-capable workflow job still declares its required permissions explicitly. Jobs that execute downloaded RTK binaries or repository tests remain read-only.

## 4. Create `RELEASE_PAT`

The post-merge tagger cannot use `GITHUB_TOKEN`: GitHub suppresses new workflow runs caused by most events created with that token. A human-owned fine-grained token is therefore used only to push the automatic release tag.

1. Open <https://github.com/settings/personal-access-tokens/new>.
2. Create a fine-grained token named `pi-distribution release tagger`.
3. Choose and record an expiration appropriate for your maintenance schedule.
4. Restrict repository access to **Only select repositories** → `pi-distribution`.
5. Grant repository permission **Contents: Read and write**.
6. Leave all other writable repository permissions disabled.
7. Generate and copy the token.
8. Store it as the repository Actions secret `RELEASE_PAT`:

   ```bash
   gh secret set RELEASE_PAT --repo ningw42/pi-distribution
   ```

   Paste the token at the hidden prompt. Do not place it in a file, command argument, or shell history.

Rotate the secret before the token expires. A missing or expired token stops automatic tagging but does not affect human-created tags.

## 5. Protect `master` and release tags

Open <https://github.com/ningw42/pi-distribution/settings/rules>.

### `master` branch

Create a branch ruleset targeting `master` that:

- requires changes to arrive through pull requests;
- requires the CI `test` job to pass;
- blocks force pushes;
- blocks branch deletion.

The `test` status check may not appear in the selector until `ci.yml` has run once. Add it after the first run if necessary.

### Release tags

Create a tag ruleset targeting `v*.*.*` that:

- blocks tag updates;
- blocks tag deletion;
- retains an audited administrator bypass for recovery.

Do not block normal tag creation by the maintainer identity behind `RELEASE_PAT`, because both manual and automatic releases enter through tag creation.

## 6. Verify the generated-artifact path

Dispatch the updater after the workflows are present on `master`:

```bash
gh workflow run update_pi_rtk.yml --repo ningw42/pi-distribution
```

Then verify:

1. `update_pi_rtk.yml` succeeds.
2. If a newer RTK release exists, it opens `auto-update/pi-rtk-<version>` with label `auto-release:pi-rtk`.
3. The PR changes only files under `vendor/pi-rtk/`.
4. CI passes and a human reviews and merges the PR.
5. `tag_on_auto_update_merge.yml` creates the next `vYY.MM.N` annotated tag.
6. `build_and_publish_release.yml` publishes the corresponding GitHub Release.

A no-change updater run is also successful; it simply opens no PR.

## 7. Verify Renovate

After installing the App, inspect its repository in the Mend Renovate developer portal or wait for its scheduled run. Verify that its first update PR:

- uses a `renovate/npm-*` branch;
- carries `auto-release:npm`;
- changes only `package.json` and `package-lock.json`;
- updates one or more direct dependencies in the grouped PR;
- does not enable automerge.

After human review and merge, the same automatic tag and release sequence should run.

## Manual releases

A maintainer can release any intentionally selected commit without an update PR:

```bash
git tag -a v26.08.0 <commit> -m "pi-distribution v26.08.0"
git push origin v26.08.0
```

The tag enters the same `build_and_publish_release.yml` publisher as an automatic tag. The tag must match `vYY.MM.N`, and the tagged package must pass the release workflow's checks.

## Kura bootstrap

Kura remains an unreleased flake. After the first `pi-distribution` GitHub Release exists, update `../kura/pkgs/pi-distribution/default.nix` to use:

- `version = "YY.MM.N"`;
- `rev = "v${finalAttrs.version}"`;
- `nix-update-script` with `--use-github-releases`;
- the GitHub Release URL as `meta.changelog`.

Recompute the source and npm dependency hashes for that first release. Kura's existing scheduled updater can handle subsequent releases.

## Troubleshooting

### Merged updater PR produced no tag

Check that:

- the PR was merged into `master`;
- its author, branch prefix, label, and changed paths match the expected update class;
- `RELEASE_PAT` exists and is not expired;
- the token still has Contents read/write access;
- the release-tag ruleset permits tag creation by the token owner.

### Automatic tag produced no release workflow run

The tag was probably pushed with `GITHUB_TOKEN` or an unusable `RELEASE_PAT`. Inspect `tag_on_auto_update_merge.yml`, rotate the secret if needed, and retry the failed tag job. Do not introduce a second commit- or PR-triggered publication path.

### Renovate opens no PRs

Check that:

- the Renovate App installation includes `pi-distribution`;
- the repository is active in the Mend Renovate developer portal;
- `renovate.json5` validates;
- no open dependency PR is consuming the configured one-PR limit.
