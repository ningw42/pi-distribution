# pi-distribution

An aggregate [Pi package](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) containing a cohesive set of coding-agent extensions and curated Pi resources.

The package exposes extensions through a uniform forwarding-shim layer, skills, and the theme collections shipped by the pinned `pi-cc-extensions` and `@sherif-fanous/pi-catppuccin` dependencies. None of the aggregated implementations ships a prompt template.

## Included resources

### Extensions

| Extension | Implementation source | Version source |
|---|---|---|
| `pi-rtk` | Canonical generated Pi integration from `rtk-ai/rtk` | [`vendor/pi-rtk/metadata.json`](vendor/pi-rtk/metadata.json) |
| `pi-statusline` | Package-maintained portable statusline consuming the pure `tps.ts` module from the pinned `@everyx/pi-status-line` dependency for TTFT and decode TPS | repository version; module pin in `package.json` |
| `pi-status` | npm dependency `@thinkscape/pi-status`; drives the terminal tab title and Ghostty OSC 9;4 progress bar | `package.json` |
| `rpiv-ask-user-question` | npm dependency `@juicesharp/rpiv-ask-user-question` | `package.json` |
| `rpiv-btw` | npm dependency `@juicesharp/rpiv-btw`; adds `/btw` side questions in an ephemeral overlay | `package.json` |
| `pi-cc-extensions` | npm dependency | `package.json` |
| `pi-dynamic-workflows` | npm dependency `@quintinshaw/pi-dynamic-workflows` | `package.json` |
| `pi-inline-skills` | npm dependency `@tifan/pi-inline-skills`; adds inline `/skill` autocomplete and loads referenced skills for the turn | `package.json` |
| `pi-input-history` | npm dependency; restores per-directory prompt history across sessions for Up/Down navigation and configurable fuzzy reverse search | `package.json` |
| `pi-mcp-adapter` | npm dependency | `package.json` |
| `pi-theme-picker` | npm dependency; adds the `/theme` picker | `package.json` |
| `pi-subagents` | npm dependency `@tintinweb/pi-subagents` | `package.json` |
| `pi-tasks` | npm dependency `@tintinweb/pi-tasks` | `package.json` |

The statusline imports the pure `tps.ts` metrics module from the pinned
`@everyx/pi-status-line` dependency. That package's own Pi extension entry is
not exposed, and Pi does not activate dependency manifests.

Once a turn starts, the output suffix shows TTFT then decode speed together:
`(󱦟 1.4s 󱐋 82 T/s)`. Live and finalized speeds are rounded to whole tokens per
second. TTFT counts the pending wait, then freezes at the first text, thinking,
or tool-call delta while speed updates alongside it. Unavailable
TTFT uses `—` and speed uses `· T/s`; a request ending before its first token has
no measured TTFT.
Both readings remain after completion and reset for the next turn. The pair is
hidden on session start/resume/reload until a new turn begins, keeping launch
clean. The actively measured metric's glyph, value, and units use Mocha Yellow
(`#f9e2af`): TTFT while waiting, then speed while generating, even if the rate
falls. Parentheses, unavailable placeholders, and frozen readings retain the
dimmed secondary color (`#7f849c`).

The effort label uses Pi's active theme thinking-level color, matching the editor
border via `theme.getThinkingBorderColor()`. It updates when effort changes and
follows theme switches; the statusline defines no separate effort palette.

The statusline tries these layouts in order:

1. **Full single row:** all details, with four extra columns of breathing room
   beyond the required one-space gap between the left and right sections.
2. **Compact single row:** omit both parenthesized token groups (input/cache
   details and TTFT/decode speed), keeping input/output totals and all other
   sections. This layout needs only the one-space gap, without the extra buffer.
3. **Three left-aligned rows:**
   - Tokens, then cost. Keep both parenthesized groups when this row fits;
     otherwise omit them before truncating.
   - Model, effort, then context.
   - Starship directory and all Git segments.

The layout is recalculated on each render, including terminal resizes. Hidden
parenthesized details return whenever the selected layout has room for them;
measuring generation metrics continues even while they are hidden. Each row is
truncated to the available width rather than wrapped further.

### Skills and themes

| Resource | Type | Implementation source | Purpose |
|---|---|---|---|
| `workflow-authoring` | Skill | `@quintinshaw/pi-dynamic-workflows` | Guidance and supporting references/examples for authoring and debugging workflow scripts |
| `workflow-patterns` | Skill | `@quintinshaw/pi-dynamic-workflows` | Argument guidance for the five built-in workflow patterns |
| `mcp-scripting` | Skill | `pi-mcp-adapter` | Default-on, extension-discovered guidance for composing multi-call `mcpScript` programs |
| `pi-cc-extensions/themes` | Theme collection | `pi-cc-extensions` | All JSON themes shipped by the pinned dependency |
| `pi-catppuccin/themes` | Theme collection | `@sherif-fanous/pi-catppuccin` | All four Catppuccin flavors |

The root manifest names the extensions and two workflow skills through exact `node_modules/` paths and exposes the dependency-owned theme directories. `pi-mcp-adapter` contributes `mcp-scripting` through Pi's `resources_discover` extension event whenever `settings.scriptMode` is enabled. Pi does not recursively activate dependency package manifests.

## Install

The package can be installed from Git, a local checkout, or an extracted GitHub Release artifact. It is not published to the npm registry.

```bash
# Local checkout
pi install /absolute/path/to/pi-distribution

# Pinned Git revision or tag
pi install git:github.com/ningw42/pi-distribution@<revision>
```

Pi runs `npm install` for Git packages. This repository commits `package-lock.json`, uses exact dependency versions, and configures npm to leave Pi-provided peer packages unresolved so Pi supplies its own runtime modules. Installing the aggregate makes all declared resources available, plus the MCP adapter's default-on `mcp-scripting` skill.

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

The aggregate root is the public resource interface. Its `package.json` explicitly declares the static curated resource set:

- the extensions listed above;
- `workflow-authoring` and `workflow-patterns` from dynamic workflows;
- every JSON theme in the pinned Pi CC Extensions theme directory;
- all four themes in the pinned `@sherif-fanous/pi-catppuccin` package.

The MCP adapter owns the lifecycle of its `mcp-scripting` skill. It discovers the skill alongside the default-on `mcpScript` tool and hides both when `settings.scriptMode` is `false`; the aggregate does not duplicate that skill in `pi.skills`.

No dependency ships a prompt template, so `pi.prompts` is absent. Extension and statically declared skill entries use exact paths. The theme entries deliberately expose only the two dependency-owned theme directories, allowing each dependency to own its inventory without activating dependency manifests or unrelated files elsewhere under `node_modules`.

The themes are available after installation, but installation does not select one. Use the bundled `pi-theme-picker` extension's `/theme` command to preview, select, and persist a theme, or configure one manually. Theme selection remains consumer configuration.

## Development and verification

Read [AGENTS.md](AGENTS.md) for editing boundaries, test isolation, maintenance rules, and commit conventions.

Use Node.js 24 and the npm version recorded in `packageManager`. Run these commands from the repository root to install both locked dependency trees and execute the full development/release verification gate:

```bash
npm ci --ignore-scripts
npm --prefix tests/smoke-runtime ci --include=dev --ignore-scripts
npm run test:all
```

| Command | Coverage | Prerequisites |
|---|---|---|
| `npm run test:unit` | Dependency-free Node tests in `tests/unit/` | Node only; neither dependency tree needs to be installed |
| `npm run check` | Manifest, resources, shims, pins, locks, and vendored-source checks | Root production dependencies |
| `npm run test:package` | `test:unit` + `check` | Root production dependencies only |
| `npm run test:runtime` | Pi-dependent regression tests in `tests/runtime/`, including statusline layout with real ANSI/column-width utilities | Root production dependencies + smoke runtime |
| `npm test` | `test:package` + `test:runtime` | Both dependency trees; preserves all regression-test coverage |
| `npm run smoke` | Packed-artifact and real-Pi RPC verification | Both dependency trees, npm, and `tar` |
| `npm run test:all` | `npm test` + `smoke` | Both dependency trees, npm, and `tar` |

These are source-checkout commands. Production-only packagers such as Kura can run the complete package suite without installing the smoke runtime:

```bash
npm ci --omit=dev --ignore-scripts
npm run test:package
```

Offline builds must provision the root dependency closure in advance. The package suite reads the committed smoke-runtime manifest and lock, but does not require its `node_modules`.

CI runs `test:package` before installing the smoke runtime, then runs `test:runtime` and `smoke`. Native release jobs run `test:all`, retaining the exact tested tarball.

The smoke test:

1. validates the manifest, shims, pins, RTK hash, and statusline portability;
2. creates the npm tarball and checks its contents;
3. extracts that tarball into a temporary clean directory without contacting npm;
4. loads each forwarding shim independently with Pi RPC mode;
5. loads the aggregate and checks representative extension commands;
6. verifies the declared and extension-discovered skill commands and their provenance;
7. verifies that disabling MCP script mode removes both `mcpScript` and `mcp-scripting`;
8. verifies every file under the declared skill and theme resources, the extension-discovered skill file, and the absence of prompt templates;
9. fails on extension errors, missing packed resources, or extracted-manifest drift.

Set `KEEP_SMOKE_TMP=1` to retain its temporary package and logs for inspection. Set `SMOKE_PACK_DESTINATION` to retain the exact tarball that passed registry-free extraction and Pi smoke checks; the release workflow uses this on native Windows x64 and ARM64 runners.

## Repository automation

See [`AUTOMATION_SETUP.md`](AUTOMATION_SETUP.md) for the required GitHub App, credential, repository-rule, and first-run setup.

## Updating

### Package dependencies

Update runtime dependencies together and keep exact versions:

```bash
npm install --save-exact <package>@<version> [<package>@<version> ...]
npm --prefix tests/smoke-runtime ci --include=dev --ignore-scripts
npm run test:all
```

Update the independently locked Pi smoke runtime as an exact development dependency:

```bash
npm ci --ignore-scripts
npm --prefix tests/smoke-runtime install --save-dev --save-exact --include=dev --ignore-scripts \
  @earendil-works/pi-coding-agent@<version>
npm run test:all
```

Renovate groups production and smoke-runtime dependency updates into one reviewed PR.

### RTK

With both dependency trees installed as above, regenerate the vendored extension, synchronize its license, record provenance from the locally installed RTK CLI, and verify the result:

```bash
npm run update:pi-rtk
npm run test:all
```

Set `RTK_BIN=/absolute/path/to/rtk` to select a specific binary. The updater runs `rtk init -g --agent pi --no-patch` under a temporary home, verifies the generated source against the matching upstream tag, and updates only `vendor/pi-rtk/`.

## Provenance

See [`NOTICE.md`](NOTICE.md) for vendored-source and dependency provenance.
