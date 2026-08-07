# pi-distribution

A curated aggregate [Pi package](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) containing a cohesive set of coding-agent extensions.

The package exposes exactly eight extensions through a uniform forwarding-shim layer. It deliberately exposes no themes, skills, or prompt templates.

## Included extensions

| Extension | Implementation source | Pin |
|---|---|---|
| `pi-rtk` | Canonical generated Pi integration from `rtk-ai/rtk` | RTK 0.44.2 / `700bdde3343299ea06bbca18dc6670a80c88b289` |
| `pi-statusline` | Package-maintained portable statusline | repository version |
| `pi-askuserquestion` | GitHub tarball dependency, not vendored source | `ghoseb/pi-askuserquestion@e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578` |
| `pi-cc-extensions` | npm dependency | 0.8.44 |
| `pi-dynamic-workflows` | npm dependency `@quintinshaw/pi-dynamic-workflows` | 3.5.1 |
| `pi-mcp-adapter` | npm dependency | 2.21.0 |
| `pi-subagents` | npm dependency `@tintinweb/pi-subagents` | 0.14.3 |
| `pi-tasks` | npm dependency `@tintinweb/pi-tasks` | 0.7.2 |

Every public entry is `extensions/<name>/index.ts`. The entries only forward to a local implementation under `vendor/` or to a pinned package under `node_modules/`; this keeps Pi's displayed names stable and prevents dependency package manifests from exposing unrelated resources.

## Install

The package is currently intended to be installed from Git or a local checkout rather than the npm registry.

```bash
# Local checkout
pi install /absolute/path/to/pi-distribution

# Pinned Git revision or tag
pi install git:github.com/ningw42/pi-distribution@<revision>
```

Pi runs `npm install` for Git packages. This repository commits `package-lock.json`, uses exact dependency versions, and configures npm to leave Pi-provided peer packages unresolved so Pi supplies its own runtime modules.

## Runtime prerequisites

- Pi 0.84 or a compatible later version.
- `rtk >= 0.23` in `PATH`. The vendored integration currently tracks RTK 0.44.2.
- `starship` in `PATH` for the statusline's directory and Git segments.

Set `PI_STATUSLINE_STARSHIP` to use an explicit Starship binary path:

```bash
export PI_STATUSLINE_STARSHIP=/absolute/path/to/starship
```

For Pi 0.84, use this compatibility setting for `pi-cc-extensions`:

```json
{
  "fixedEditorFeatures": false
}
```

It belongs in `~/.pi/agent/claude-code-style.json`.

## Resource scope

The aggregate `package.json` declares only `pi.extensions`. It has no `pi.themes`, `pi.skills`, or `pi.prompts` keys.

Some bundled dependencies physically contain their own optional resources—for example, `pi-cc-extensions` ships themes, `pi-mcp-adapter` ships an MCP scripting skill, and `@quintinshaw/pi-dynamic-workflows` ships workflow-authoring skills. Those files may be present in the packed dependency trees, but this aggregate never declares or loads them.

## Development and verification

Install the exact lockfile closure and run the static checks:

```bash
npm ci --ignore-scripts
npm test
```

Run the packed-artifact and real-Pi smoke test:

```bash
npm run smoke
```

The smoke test:

1. validates the manifest, shims, pins, RTK hash, and statusline portability;
2. creates the npm tarball and checks its contents;
3. installs that tarball into a temporary clean prefix;
4. loads each of the eight forwarding shims independently with Pi RPC mode;
5. loads the aggregate and checks representative extension commands;
6. fails on extension errors or an aggregate-provided skill.

Set `KEEP_SMOKE_TMP=1` to retain its temporary package and logs for inspection.

## Updating

### Package dependencies

Update only one dependency at a time and keep exact versions:

```bash
npm install --save-exact <package>@<version>
npm test
npm run smoke
```

For `pi-askuserquestion`, replace the full commit in the codeload URL rather than copying its source into this repository. Review its lockfile `resolved` URL and integrity after every update.

The unscoped npm packages `pi-subagents` and `pi-tasks` are unrelated projects. Continue using `@tintinweb/pi-subagents` and `@tintinweb/pi-tasks`.

### RTK

Update `vendor/pi-rtk/index.ts` from `hooks/pi/rtk.ts` at the same RTK revision as the installed CLI, or regenerate it with:

```bash
HOME="$(mktemp -d)" rtk init -g --agent pi --no-patch
```

Then update the expected SHA-256 in `scripts/check-package.mjs`, the pin table above, and `NOTICE.md`. Keep the Apache-2.0 license copy synchronized.

### Statusline

When updating the statusline implementation, retain the portable default:

```ts
const STARSHIP_BIN = process.env.PI_STATUSLINE_STARSHIP || "starship";
```

## Provenance

See [`NOTICE.md`](NOTICE.md) for vendored-source and dependency provenance.
