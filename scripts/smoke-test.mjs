import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const rtkMetadata = JSON.parse(readFileSync(join(root, "vendor/pi-rtk/metadata.json"), "utf8"));
const piPackageDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piPackage = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8"));
const piCli = join(piPackageDir, piPackage.bin.pi);
const smokeProcessEnv = { ...process.env };
delete smokeProcessEnv.PI_PACKAGE_DIR;
const expectedSkillResources = pkg.pi.skills;
const expectedThemeResources = pkg.pi.themes;
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

function collectResourceFiles(path) {
  const absolutePath = join(root, path);
  if (!statSync(absolutePath).isDirectory()) return [path];
  return readdirSync(absolutePath).flatMap((entry) => collectResourceFiles(join(path, entry)));
}

const expectedSkillFiles = expectedSkillResources.flatMap(collectResourceFiles);
const expectedThemeFiles = expectedThemeResources.flatMap(collectResourceFiles);

function rpcSmoke(source) {
  const result = run(
    process.execPath,
    [piCli, "--mode", "rpc", "--no-session", "-e", source],
    {
      cwd: workDir,
      input: '{"id":"smoke","type":"get_commands"}\n',
      timeout: 30_000,
      env: {
        ...smokeProcessEnv,
        HOME: homeDir,
        XDG_CONFIG_HOME: join(homeDir, ".config"),
        PI_CODING_AGENT_DIR: configDir,
        PATH: `${binDir}:${smokeProcessEnv.PATH ?? ""}`,
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
  assert.equal(
    piPackage.version,
    pkg.devDependencies["@earendil-works/pi-coding-agent"],
    "the smoke test must use the lockfile-controlled Pi development dependency",
  );
  assert.equal(existsSync(piCli), true, `missing locked Pi CLI: ${piCli}`);
  console.log(`using locked Pi ${piPackage.version}`);

  run(process.execPath, [join(root, "scripts/check-package.mjs")]);

  writeExecutable(
    "rtk",
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "rtk ${rtkMetadata.version}"\n  exit 0\nfi\nif [ "$1" = "rewrite" ]; then\n  exit 1\nfi\nexit 1\n`,
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
    "package/extensions/rpiv-ask-user-question/index.ts",
    "package/extensions/pi-cc-extensions/index.ts",
    "package/extensions/pi-dynamic-workflows/index.ts",
    "package/extensions/pi-mcp-adapter/index.ts",
    "package/extensions/pi-subagents/index.ts",
    "package/extensions/pi-tasks/index.ts",
    "package/vendor/pi-rtk/index.ts",
    "package/vendor/pi-rtk/LICENSE",
    "package/vendor/pi-rtk/metadata.json",
    "package/vendor/pi-statusline/index.ts",
    "package/node_modules/@juicesharp/rpiv-ask-user-question/index.ts",
    "package/node_modules/@juicesharp/rpiv-ask-user-question/LICENSE",
    "package/node_modules/pi-cc-extensions/extensions/index.ts",
    "package/node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts",
    "package/node_modules/@quintinshaw/pi-dynamic-workflows/package.json",
    "package/node_modules/@quintinshaw/pi-dynamic-workflows/LICENSE",
    "package/node_modules/pi-mcp-adapter/index.ts",
    "package/node_modules/@tintinweb/pi-subagents/src/index.ts",
    "package/node_modules/@tintinweb/pi-tasks/src/index.ts",
    ...[...expectedSkillFiles, ...expectedThemeFiles].map(
      (path) => `package/${path.replace(/^\.\//, "")}`,
    ),
  ];
  for (const entry of requiredArchiveEntries) {
    assert.equal(archiveEntries.includes(entry), true, `packed artifact is missing ${entry}`);
  }
  for (const forbiddenPrefix of [
    "package/.pi/",
    "package/skills/",
    "package/themes/",
    "package/prompts/",
    "package/node_modules/@earendil-works/pi-coding-agent/",
  ]) {
    assert.equal(
      archiveEntries.some((entry) => entry.startsWith(forbiddenPrefix)),
      false,
      `packed artifact unexpectedly contains ${forbiddenPrefix}`,
    );
  }

  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--prefix", installDir, tarball]);
  const installedPackage = join(installDir, "node_modules", pkg.name);
  assert.equal(existsSync(join(installedPackage, "package.json")), true);
  const installedManifest = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8"));
  assert.deepEqual(installedManifest.pi, pkg.pi);

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
  const expectedSkillCommands = [
    [
      "skill:workflow-authoring",
      join(
        installedPackage,
        "node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/SKILL.md",
      ),
      "cli",
      "temporary",
      "top-level",
    ],
    [
      "skill:workflow-patterns",
      join(
        installedPackage,
        "node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-patterns/SKILL.md",
      ),
      "cli",
      "temporary",
      "top-level",
    ],
    [
      "skill:mcp-scripting",
      join(installedPackage, "node_modules/pi-mcp-adapter/skills/mcp-scripting/SKILL.md"),
      "cli",
      "temporary",
      "top-level",
    ],
  ].sort(([left], [right]) => left.localeCompare(right));
  const skillCommands = commands
    .filter((command) => command.source === "skill")
    .map((command) => [
      command.name,
      command.sourceInfo?.path,
      command.sourceInfo?.source,
      command.sourceInfo?.scope,
      command.sourceInfo?.origin,
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(skillCommands, expectedSkillCommands, "aggregate skill commands or provenance differ");
  assert.deepEqual(
    commands.filter((command) => command.source === "prompt"),
    [],
    "the aggregate exposed an undeclared prompt template",
  );

  console.log(
    `smoke test passed: ${pkg.pi.extensions.length} extensions, ${pkg.pi.skills.length} skills, and ${expectedThemeFiles.filter((path) => path.endsWith(".json")).length} themes loaded from ${packed.filename} (${packed.size} bytes)`,
  );
} finally {
  if (process.env.KEEP_SMOKE_TMP === "1") {
    console.log(`kept smoke-test directory: ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
