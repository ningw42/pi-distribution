import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getPiCommands } from "../helpers/pi-rpc.mjs";

const adapter = fileURLToPath(new URL("../../extensions/pi-mcp-adapter/index.ts", import.meta.url));

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

function assertIsolatedAdapter(commands) {
  const mcp = commands.find((command) => command.name === "mcp");
  assert.ok(mcp, "the explicitly loaded adapter is missing /mcp");
  assert.equal(mcp.source, "extension");
  assert.equal(mcp.sourceInfo?.path, adapter);
  assert.equal(commands.some((command) => command.name === "ambient-command"), false);
  assert.equal(commands.some((command) => command.sourceInfo?.source === "builtin"), false);
  assert.equal(commands.some((command) => command.name === "skill:mcp-scripting"), true);
}

test("RPC isolates an explicit MCP shim from ambient and built-in command collisions", (t) => {
  const { options } = fixture(t);
  assertIsolatedAdapter(getPiCommands(adapter, options));
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
  const commands = getPiCommands([adapter, probe], options);
  assertIsolatedAdapter(commands);
  assert.equal(commands.find((command) => command.name === "explicit-probe")?.sourceInfo?.path, probe);
});
