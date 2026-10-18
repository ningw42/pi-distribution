import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getPiCommands } from "../helpers/pi-rpc.mjs";

const loop = fileURLToPath(new URL("../../extensions/pi-loop/index.ts", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-rpc-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const config = join(root, "pi-config");
  const cwd = join(root, "work");
  for (const path of [home, join(config, "extensions"), cwd]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(
    join(config, "extensions", "ambient.ts"),
    `export default function (pi) {\n` +
      `  pi.registerCommand("ambient-command", { handler: async () => {} });\n` +
      `  pi.registerCommand("mcp", { handler: async () => {} });\n` +
      `}\n`,
  );
  return {
    root,
    options: {
      cwd,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PI_CODING_AGENT_DIR: config,
        NO_COLOR: "1",
      },
    },
  };
}

function assertIsolatedLoop(commands) {
  const loopCommand = commands.find((command) => command.name === "loop");
  assert.ok(loopCommand, "the explicitly loaded loop shim is missing /loop");
  assert.equal(loopCommand.source, "extension");
  assert.equal(loopCommand.sourceInfo?.path, loop);
  assert.equal(commands.some((command) => command.name === "ambient-command"), false);
  // Both the ambient fixture and Pi's built-in MCP register /mcp.
  assert.equal(commands.some((command) => command.name === "mcp"), false);
  assert.equal(commands.some((command) => command.sourceInfo?.source === "builtin"), false);
}

test("RPC isolates an explicit shim from ambient and built-in commands", (t) => {
  const { options } = fixture(t);
  assertIsolatedLoop(getPiCommands(loop, options));
});

test("RPC isolation still loads every explicitly requested extension", (t) => {
  const { root, options } = fixture(t);
  const probe = join(root, "probe.mjs");
  writeFileSync(
    probe,
    `export default function (pi) {\n` +
      `  pi.registerCommand("explicit-probe", { handler: async () => {} });\n` +
      `}\n`,
  );
  const commands = getPiCommands([loop, probe], options);
  assertIsolatedLoop(commands);
  assert.equal(commands.find((command) => command.name === "explicit-probe")?.sourceInfo?.path, probe);
});

test("RPC loads only the loop command and leaves project state untouched", (t) => {
  const { options } = fixture(t);
  const commands = getPiCommands(loop, options);
  assert.deepEqual(
    commands.filter((command) => command.source === "extension").map((command) => command.name),
    ["loop"],
  );
  assert.equal(commands.find((command) => command.name === "loop")?.sourceInfo?.path, loop);
  assert.deepEqual(commands.filter((command) => command.source === "skill"), []);
  assert.deepEqual(commands.filter((command) => command.source === "prompt"), []);
  assert.equal(existsSync(join(options.cwd, ".pi-loop")), false);
});
