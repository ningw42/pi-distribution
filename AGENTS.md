# Repository instructions

## Change boundaries

- Keep `extensions/<name>/index.ts` as one-line forwarding shims, preserving public extension names. Change upstream npm implementations through dependency updates, not edits to `node_modules/`.
- `vendor/pi-statusline/` is package-maintained. Preserve its portable Starship lookup and override contract in [Runtime prerequisites](README.md#runtime-prerequisites).
- Treat `vendor/pi-rtk/` as generated: follow the [RTK update procedure](README.md#rtk), keeping upstream source, metadata hashes, and license synchronized rather than hand-patching the integration.
- When adding or removing resources, synchronize the manifest, bundled dependencies, lockfile, shims, explicit inventories in `scripts/check-package.mjs` and `scripts/smoke-test.mjs`, README resource tables, and `NOTICE.md` provenance. Preserve the [declared resource scope](README.md#resource-scope).
- Keep runtime code and packaging portable across Linux and native Windows x64/ARM64; avoid machine-specific paths and shell assumptions.

## Validation

- For code, dependency, resource, or workflow changes, run the full gate in [Development and verification](README.md#development-and-verification). That section owns setup commands, suite selection, and smoke diagnostics.
- Put dependency-free regressions in `tests/unit/` and Pi-dependent regressions in `tests/runtime/`.
- Keep the root manifest/lock production-only; isolate Pi test dependencies in the independently locked `tests/smoke-runtime/`. Install its dev dependencies explicitly, as shown in the setup instructions.
- Resolve Pi in runtime tests and smoke tooling through `tests/helpers/pi-runtime.mjs`, not an ambient installation or ancestor modules. Preserve its fail-fast preflight rather than skipping tests when the runtime is missing or stale.

## Maintenance

- Follow [Package dependencies](README.md#package-dependencies) for updates. Keep `@tintinweb/pi-subagents` and `@tintinweb/pi-tasks`: the unscoped packages are unrelated projects.
- Before changing `.github/`, `renovate.json5`, or release behavior, read [AUTOMATION_SETUP.md](AUTOMATION_SETUP.md) for event flow, credential boundaries, and release verification.
- Keep user-facing behavior and installation docs in `README.md`, third-party licenses/provenance in `NOTICE.md`, and agent instructions here; link rather than duplicate.

## Commits

Use Conventional Commits for every new or amended commit:
`type(scope): description` (scope is optional).
Example: `feat(statusline): use Pi theme colors for effort`.
