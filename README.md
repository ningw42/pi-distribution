# pi-distribution

An aggregate [Pi package](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) containing a cohesive set of coding-agent extensions and curated Pi resources.

The package exposes extensions through a uniform forwarding-shim layer, skills, and the theme collections shipped by the pinned `pi-cc-extensions` and `@sherif-fanous/pi-catppuccin` dependencies. None of the aggregated implementations ships a prompt template.

## Included resources

### Extensions

| Extension | Implementation source | Version source |
|---|---|---|
| `pi-rtk` | Canonical generated Pi integration from `rtk-ai/rtk` | [`vendor/pi-rtk/metadata.json`](vendor/pi-rtk/metadata.json) |
| `pi-statusline` | Package-maintained portable statusline | repository version |
| `pi-status` | npm dependency `@thinkscape/pi-status`; drives the terminal tab title and Ghostty OSC 9;4 progress bar | `package.json` |
| `rpiv-ask-user-question` | npm dependency `@juicesharp/rpiv-ask-user-question` | `package.json` |
| `pi-cc-extensions` | npm dependency | `package.json` |
| `pi-dynamic-workflows` | npm dependency `@quintinshaw/pi-dynamic-workflows` | `package.json` |
| `pi-inline-skills` | npm dependency `@tifan/pi-inline-skills`; adds inline `/skill` autocomplete and loads referenced skills for the turn | `package.json` |
| `pi-mcp-adapter` | npm dependency | `package.json` |
| `pi-theme-picker` | npm dependency; adds the `/theme` picker | `package.json` |
| `pi-subagents` | npm dependency `@tintinweb/pi-subagents` | `package.json` |
| `pi-tasks` | npm dependency `@tintinweb/pi-tasks` | `package.json` |

Every public extension entry is `extensions/<name>/index.ts`. The entries only forward to a local implementation under `vendor/` or to a pinned package under `node_modules/`, which keeps Pi's displayed extension names stable.

### Skills and themes

| Resource | Type | Implementation source | Purpose |
|---|---|---|---|
| `workflow-authoring` | Skill | `@quintinshaw/pi-dynamic-workflows` | Guidance and supporting references/examples for authoring and debugging workflow scripts |
| `workflow-patterns` | Skill | `@quintinshaw/pi-dynamic-workflows` | Argument guidance for the five built-in workflow patterns |
| `mcp-scripting` | Skill | `pi-mcp-adapter` | Guidance for composing multi-call `mcpScript` programs |
| `pi-cc-extensions/themes` | Theme collection | `pi-cc-extensions` | All JSON themes shipped by the pinned dependency |
| `pi-catppuccin/themes` | Theme collection | `@sherif-fanous/pi-catppuccin` | All four Catppuccin flavors |

The root manifest names the extensions and skills through exact `node_modules/` paths and exposes the dependency-owned theme directories. Pi does not recursively activate dependency package manifests.

## Install

The package can be installed from Git, a local checkout, or an extracted GitHub Release artifact. It is not published to the npm registry.

```bash
# Local checkout
pi install /absolute/path/to/pi-distribution

# Pinned Git revision or tag
pi install git:github.com/ningw42/pi-distribution@<revision>
```

Pi runs `npm install` for Git packages. This repository commits `package-lock.json`, uses exact dependency versions, and configures npm to leave Pi-provided peer packages unresolved so Pi supplies its own runtime modules. Installing the aggregate makes all declared extensions, skills, and themes available.

### Offline Windows release artifact

Each GitHub Release includes fully packed Windows x64 and ARM64 artifacts plus SHA-256 checksum files. Select the asset matching the target machine, transfer both files to it, and use PowerShell to verify and extract the package:

```powershell
$tag = "v26.08.4"       # Release to install
$architecture = "x64"   # Use "arm64" on Windows ARM64
$asset = "pi-distribution-$tag-windows-$architecture.tgz"

$expected = (Get-Content "$asset.sha256").Split()[0].ToLowerInvariant()
$actual = (Get-FileHash $asset -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Checksum mismatch for $asset" }

$destination = Join-Path $HOME "pi-packages\pi-distribution-$tag"
New-Item -ItemType Directory -Path $destination -Force | Out-Null
tar -xzf $asset -C $destination --strip-components=1
pi install $destination
```

The extracted directory already contains the package's npm runtime dependency closure, so installation does not contact the npm registry. Pi itself and the external `rtk` and `starship` runtime prerequisites are not included.

## Runtime prerequisites

- Pi 0.84 or a compatible later version.
- `rtk >= 0.23` in `PATH`. The tracked generator release is recorded in [`vendor/pi-rtk/metadata.json`](vendor/pi-rtk/metadata.json).
- `starship` in `PATH` for the statusline's directory and Git segments.

Set `PI_STATUSLINE_STARSHIP` to use an explicit Starship binary path:

```bash
export PI_STATUSLINE_STARSHIP=/absolute/path/to/starship
```

## Resource scope

The aggregate root is the public resource interface. Its `package.json` explicitly declares the complete curated resource set:

- the extensions listed above;
- `workflow-authoring` and `workflow-patterns` from dynamic workflows;
- `mcp-scripting` from the MCP adapter;
- every JSON theme in the pinned Pi CC Extensions theme directory;
- all four themes in the pinned `@sherif-fanous/pi-catppuccin` package.

No dependency ships a prompt template, so `pi.prompts` is absent. Extension and skill entries use exact paths. The theme entries deliberately expose only the two dependency-owned theme directories, allowing each dependency to own its inventory without activating dependency manifests or unrelated files elsewhere under `node_modules`.

The themes are available after installation, but installation does not select one. Use the bundled `pi-theme-picker` extension's `/theme` command to preview, select, and persist a theme, or configure one manually. Theme selection remains consumer configuration.

## Development and verification

Install the production package closure and the independently locked Pi smoke runtime, then run the static checks:

```bash
npm ci --ignore-scripts
npm --prefix tests/smoke-runtime ci --ignore-scripts
npm test
```

Run the packed-artifact and real-Pi smoke test:

```bash
npm run smoke
```

The root lock contains only the production package closure consumed by installers. The exact Pi version used for compatibility testing lives under `tests/smoke-runtime`, so Pi updates cannot add test-only packages to the production closure.

The smoke test invokes the exact npm Pi development dependency from the lockfile. It does not use an ambient `pi` executable or `PI_PACKAGE_DIR`, so local and CI runs exercise the same Pi runtime.

The smoke test:

1. validates the manifest, shims, pins, RTK hash, and statusline portability;
2. creates the npm tarball and checks its contents;
3. extracts that tarball into a temporary clean directory without contacting npm;
4. loads each forwarding shim independently with Pi RPC mode;
5. loads the aggregate and checks representative extension commands;
6. verifies the declared skill commands and their provenance;
7. verifies every file under the declared skill and theme resources and the absence of prompt templates;
8. fails on extension errors, missing packed resources, or extracted-manifest drift.

Set `KEEP_SMOKE_TMP=1` to retain its temporary package and logs for inspection. Set `SMOKE_PACK_DESTINATION` to retain the exact tarball that passed registry-free extraction and Pi smoke checks; the release workflow uses this on native Windows x64 and ARM64 runners.

## Repository automation

See [`AUTOMATION_SETUP.md`](AUTOMATION_SETUP.md) for the required GitHub App, credential, repository-rule, and first-run setup.

## Updating

### Package dependencies

Update runtime dependencies together and keep exact versions:

```bash
npm install --save-exact <package>@<version> [<package>@<version> ...]
npm test
npm run smoke
```

Update the independently locked Pi smoke runtime as an exact development dependency:

```bash
npm --prefix tests/smoke-runtime install --save-dev --save-exact \
  @earendil-works/pi-coding-agent@<version>
npm test
npm run smoke
```

Renovate groups both kinds of update into one reviewed PR. The unscoped npm packages `pi-subagents` and `pi-tasks` are unrelated projects. Continue using `@tintinweb/pi-subagents` and `@tintinweb/pi-tasks`.

### RTK

Regenerate the vendored extension, synchronize its license, and record provenance from the locally installed RTK CLI with:

```bash
npm run update:pi-rtk
```

Set `RTK_BIN=/absolute/path/to/rtk` to select a specific binary. The updater runs `rtk init -g --agent pi --no-patch` under a temporary home, verifies the generated source against the matching upstream tag, and updates only `vendor/pi-rtk/`.

### Statusline

When updating the statusline implementation, retain the portable default:

```ts
const STARSHIP_BIN = process.env.PI_STATUSLINE_STARSHIP || "starship";
```

## Provenance

See [`NOTICE.md`](NOTICE.md) for vendored-source and dependency provenance.
