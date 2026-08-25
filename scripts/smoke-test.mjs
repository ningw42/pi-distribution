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
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const rtkMetadata = JSON.parse(readFileSync(join(root, "vendor/pi-rtk/metadata.json"), "utf8"));
const smokeRuntimeRoot = join(root, "tests", "smoke-runtime");
const smokeRuntimePackage = JSON.parse(
  readFileSync(join(smokeRuntimeRoot, "package.json"), "utf8"),
);
const piPackageDir = join(
  smokeRuntimeRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const piPackage = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8"));
const piCli = join(piPackageDir, piPackage.bin.pi);
const smokeProcessEnv = { ...process.env };
delete smokeProcessEnv.PI_PACKAGE_DIR;
const expectedSkillResources = pkg.pi.skills;
const expectedThemeResources = pkg.pi.themes;
const tempRoot = mkdtempSync(join(tmpdir(), "pi-distribution-smoke-"));
const retainedPackDir = process.env.SMOKE_PACK_DESTINATION;
const packDir = retainedPackDir ? resolve(retainedPackDir) : join(tempRoot, "pack");
const extractDir = join(tempRoot, "extract");
const homeDir = join(tempRoot, "home");
const configDir = join(tempRoot, "pi-config");
const workDir = join(tempRoot, "work");
const binDir = join(tempRoot, "bin");
for (const path of [packDir, extractDir, homeDir, configDir, workDir, binDir]) {
  mkdirSync(path, { recursive: true });
}

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

function runNpm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    shell: process.platform === "win32",
    ...options,
  });
}

function writeExecutable(name, unixBody, windowsBody) {
  const isWindows = process.platform === "win32";
  const path = join(binDir, `${name}${isWindows ? ".cmd" : ""}`);
  writeFileSync(path, isWindows ? windowsBody : unixBody);
  if (!isWindows) chmodSync(path, 0o755);
}

const toArchivePath = (path) => path.replaceAll("\\", "/").replace(/^\.\//, "");

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
        PATH: `${binDir}${delimiter}${smokeProcessEnv.PATH ?? ""}`,
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
    smokeRuntimePackage.devDependencies["@earendil-works/pi-coding-agent"],
    "the smoke test must use the independently locked Pi development dependency",
  );
  assert.equal(existsSync(piCli), true, `missing locked Pi CLI: ${piCli}`);
  console.log(`using locked Pi ${piPackage.version}`);

  run(process.execPath, [join(root, "scripts/check-package.mjs")]);

  writeExecutable(
    "rtk",
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "rtk ${rtkMetadata.version}"\n  exit 0\nfi\nif [ "$1" = "rewrite" ]; then\n  exit 1\nfi\nexit 1\n`,
    `@echo off\r\nif "%~1"=="--version" (\r\n  echo rtk ${rtkMetadata.version}\r\n  exit /b 0\r\n)\r\nif "%~1"=="rewrite" exit /b 1\r\nexit /b 1\r\n`,
  );
  writeExecutable("starship", "#!/bin/sh\nexit 0\n", "@echo off\r\nexit /b 0\r\n");

  const packResult = runNpm(["pack", "--json", "--pack-destination", packDir]);
  const packed = JSON.parse(packResult.stdout)[0];
  const tarball = join(packDir, packed.filename);
  assert.equal(existsSync(tarball), true);

  const archiveEntries = packed.files.map(({ path }) => toArchivePath(path));
  const platformKey = `${process.platform}-${process.arch}`;
  const platformArchiveEntries = {
    "win32-x64": [
      "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
      "node_modules/recheck-windows-x64/package.json",
    ],
    "win32-arm64": [
      "node_modules/@napi-rs/keyring-win32-arm64-msvc/package.json",
      "node_modules/recheck-jar/package.json",
    ],
  }[platformKey] ?? [];
  const forbiddenPlatformPrefixes = {
    "win32-x64": ["node_modules/@napi-rs/keyring-win32-arm64-msvc/"],
    "win32-arm64": [
      "node_modules/@napi-rs/keyring-win32-x64-msvc/",
      "node_modules/recheck-windows-x64/",
    ],
  }[platformKey] ?? [];
  const requiredArchiveEntries = [
    "package.json",
    "extensions/pi-rtk/index.ts",
    "extensions/pi-statusline/index.ts",
    "extensions/pi-status/index.ts",
    "extensions/rpiv-ask-user-question/index.ts",
    "extensions/rpiv-btw/index.ts",
    "extensions/pi-cc-extensions/index.ts",
    "extensions/pi-dynamic-workflows/index.ts",
    "extensions/pi-inline-skills/index.ts",
    "extensions/pi-mcp-adapter/index.ts",
    "extensions/pi-theme-picker/index.ts",
    "extensions/pi-subagents/index.ts",
    "extensions/pi-tasks/index.ts",
    "vendor/pi-rtk/index.ts",
    "vendor/pi-rtk/LICENSE",
    "vendor/pi-rtk/metadata.json",
    "vendor/pi-statusline/index.ts",
    "node_modules/@juicesharp/rpiv-ask-user-question/index.ts",
    "node_modules/@juicesharp/rpiv-ask-user-question/LICENSE",
    "node_modules/@juicesharp/rpiv-btw/index.ts",
    "node_modules/@juicesharp/rpiv-btw/LICENSE",
    "node_modules/@juicesharp/rpiv-btw/prompts/btw-system.txt",
    "node_modules/pi-cc-extensions/extensions/index.ts",
    "node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts",
    "node_modules/@quintinshaw/pi-dynamic-workflows/package.json",
    "node_modules/@quintinshaw/pi-dynamic-workflows/LICENSE",
    "node_modules/@sherif-fanous/pi-catppuccin/package.json",
    "node_modules/@sherif-fanous/pi-catppuccin/LICENSE",
    "node_modules/pi-mcp-adapter/index.ts",
    "node_modules/@thinkscape/pi-status/src/index.ts",
    "node_modules/@thinkscape/pi-status/LICENSE",
    "node_modules/@tifan/pi-inline-skills/package.json",
    "node_modules/@tifan/pi-inline-skills/src/index.ts",
    "node_modules/pi-theme-picker/index.ts",
    "node_modules/pi-theme-picker/LICENSE",
    "node_modules/@tintinweb/pi-subagents/src/index.ts",
    "node_modules/@tintinweb/pi-tasks/src/index.ts",
    ...platformArchiveEntries,
    ...[...expectedSkillFiles, ...expectedThemeFiles].map(toArchivePath),
  ];
  assert.ok(platformArchiveEntries.length > 0 || process.platform !== "win32", `unsupported Windows artifact target: ${platformKey}`);
  for (const entry of requiredArchiveEntries) {
    assert.equal(archiveEntries.includes(entry), true, `packed artifact is missing ${entry}`);
  }
  for (const forbiddenPrefix of [
    ".pi/",
    "skills/",
    "themes/",
    "prompts/",
    "node_modules/@earendil-works/pi-coding-agent/",
    ...forbiddenPlatformPrefixes,
  ]) {
    assert.equal(
      archiveEntries.some((entry) => entry.startsWith(forbiddenPrefix)),
      false,
      `packed artifact unexpectedly contains ${forbiddenPrefix}`,
    );
  }

  run("tar", ["-xzf", packed.filename, "-C", extractDir], { cwd: packDir });
  const extractedPackage = join(extractDir, "package");
  assert.equal(existsSync(join(extractedPackage, "package.json")), true);
  const extractedManifest = JSON.parse(readFileSync(join(extractedPackage, "package.json"), "utf8"));
  assert.deepEqual(extractedManifest.pi, pkg.pi);
  for (const entry of platformArchiveEntries) {
    assert.equal(existsSync(join(extractedPackage, entry)), true, `extracted artifact is missing ${entry}`);
  }

  run(
    process.execPath,
    [
      "-e",
      `const assert = require("node:assert/strict");\n` +
        `const keyring = require("./node_modules/@napi-rs/keyring");\n` +
        `assert.equal(typeof keyring.Entry, "function");\n` +
        `const { checkSync } = require("./node_modules/recheck");\n` +
        `assert.equal(checkSync("a+", "").status, "safe");\n`,
    ],
    {
      cwd: extractedPackage,
      timeout: 60_000,
      env: {
        ...process.env,
        ...(platformKey === "win32-arm64" ? { RECHECK_SYNC_BACKEND: "pure" } : {}),
      },
    },
  );

  for (const extension of pkg.pi.extensions) {
    const source = join(extractedPackage, extension);
    rpcSmoke(source);
    console.log(`loaded ${basename(dirname(source))}`);
  }

  const commands = rpcSmoke(extractedPackage);
  const commandNames = new Set(commands.filter((command) => command.source === "extension").map((command) => command.name));
  for (const expectedCommand of [
    "agents",
    "btw",
    "loaded-skills",
    "tasks",
    "mcp",
    "pi-status",
    "theme",
    "workflows",
  ]) {
    assert.equal(commandNames.has(expectedCommand), true, `aggregate is missing /${expectedCommand}`);
  }
  const expectedSkillCommands = [
    [
      "skill:workflow-authoring",
      join(
        extractedPackage,
        "node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/SKILL.md",
      ),
      "cli",
      "temporary",
      "top-level",
    ],
    [
      "skill:workflow-patterns",
      join(
        extractedPackage,
        "node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-patterns/SKILL.md",
      ),
      "cli",
      "temporary",
      "top-level",
    ],
    [
      "skill:mcp-scripting",
      join(extractedPackage, "node_modules/pi-mcp-adapter/skills/mcp-scripting/SKILL.md"),
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
