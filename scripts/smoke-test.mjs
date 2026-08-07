import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tempRoot = mkdtempSync(join(tmpdir(), "pi-distribution-smoke-"));
const packDir = join(tempRoot, "pack");
const installDir = join(tempRoot, "install");
const homeDir = join(tempRoot, "home");
const configDir = join(tempRoot, "pi-config");
const workDir = join(tempRoot, "work");
const binDir = join(tempRoot, "bin");
for (const path of [packDir, installDir, homeDir, configDir, workDir, binDir]) mkdirSync(path, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "spawn error"})`,
        result.error?.stack,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

function writeExecutable(name, body) {
  const path = join(binDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function rpcSmoke(source) {
  const result = run(
    "pi",
    ["--mode", "rpc", "--no-session", "-e", source],
    {
      cwd: workDir,
      input: '{"id":"smoke","type":"get_commands"}\n',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: join(homeDir, ".config"),
        PI_CODING_AGENT_DIR: configDir,
        PATH: `${binDir}:${process.env.PATH}`,
        NO_COLOR: "1",
      },
    },
  );

  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const extensionErrors = events.filter((event) => event.type === "extension_error");
  assert.deepEqual(extensionErrors, [], `${source} emitted extension_error`);
  const response = events.find((event) => event.id === "smoke" && event.type === "response");
  assert.ok(response, `${source} did not answer get_commands`);
  assert.equal(response.success, true, `${source} returned an unsuccessful RPC response`);
  return response.data.commands;
}

try {
  run(process.execPath, [join(root, "scripts/check-package.mjs")]);

  writeExecutable(
    "rtk",
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "rtk 0.44.2"\n  exit 0\nfi\nif [ "$1" = "rewrite" ]; then\n  exit 1\nfi\nexit 1\n`,
  );
  writeExecutable("starship", "#!/bin/sh\nexit 0\n");

  const packResult = run("npm", ["pack", "--json", "--pack-destination", packDir]);
  const packed = JSON.parse(packResult.stdout)[0];
  const tarball = join(packDir, packed.filename);
  assert.equal(existsSync(tarball), true);

  const archiveEntries = run("tar", ["-tzf", tarball]).stdout.split("\n");
  const requiredArchiveEntries = [
    "package/package.json",
    "package/extensions/pi-rtk/index.ts",
    "package/extensions/pi-statusline/index.ts",
    "package/extensions/pi-askuserquestion/index.ts",
    "package/extensions/pi-cc-extensions/index.ts",
    "package/extensions/pi-dynamic-workflows/index.ts",
    "package/extensions/pi-mcp-adapter/index.ts",
    "package/extensions/pi-subagents/index.ts",
    "package/extensions/pi-tasks/index.ts",
    "package/vendor/pi-rtk/index.ts",
    "package/vendor/pi-statusline/index.ts",
    "package/node_modules/pi-askuserquestion/src/index.ts",
    "package/node_modules/pi-cc-extensions/extensions/index.ts",
    "package/node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts",
    "package/node_modules/@quintinshaw/pi-dynamic-workflows/package.json",
    "package/node_modules/@quintinshaw/pi-dynamic-workflows/LICENSE",
    "package/node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/SKILL.md",
    "package/node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-patterns/SKILL.md",
    "package/node_modules/pi-mcp-adapter/index.ts",
    "package/node_modules/@tintinweb/pi-subagents/src/index.ts",
    "package/node_modules/@tintinweb/pi-tasks/src/index.ts",
  ];
  for (const entry of requiredArchiveEntries) {
    assert.equal(archiveEntries.includes(entry), true, `packed artifact is missing ${entry}`);
  }
  for (const forbiddenPrefix of ["package/.pi/", "package/skills/", "package/themes/", "package/prompts/"]) {
    assert.equal(
      archiveEntries.some((entry) => entry.startsWith(forbiddenPrefix)),
      false,
      `packed artifact unexpectedly contains ${forbiddenPrefix}`,
    );
  }

  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--prefix", installDir, tarball]);
  const installedPackage = join(installDir, "node_modules", pkg.name);
  assert.equal(existsSync(join(installedPackage, "package.json")), true);

  for (const extension of pkg.pi.extensions) {
    const source = join(installedPackage, extension);
    rpcSmoke(source);
    console.log(`loaded ${basename(dirname(source))}`);
  }

  const commands = rpcSmoke(installedPackage);
  const commandNames = new Set(commands.filter((command) => command.source === "extension").map((command) => command.name));
  for (const expectedCommand of ["agents", "tasks", "mcp", "workflows"]) {
    assert.equal(commandNames.has(expectedCommand), true, `aggregate is missing /${expectedCommand}`);
  }
  assert.equal(
    commands.some(
      (command) =>
        command.source === "skill" &&
        JSON.stringify(command).includes(installedPackage),
    ),
    false,
    "the aggregate exposed a dependency-provided skill",
  );

  console.log(
    `smoke test passed: ${pkg.pi.extensions.length} extensions loaded from ${packed.filename} (${packed.size} bytes)`,
  );
} finally {
  if (process.env.KEEP_SMOKE_TMP === "1") {
    console.log(`kept smoke-test directory: ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
