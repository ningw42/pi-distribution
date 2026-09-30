import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { getPiRuntime } from "./pi-runtime.mjs";

// Shared by the packed-artifact smoke test and real-Pi RPC regressions.
export function getPiCommands(source, { cwd, env } = {}) {
  const sources = Array.isArray(source) ? source : [source];
  const sourceArgs = sources.flatMap((path) => ["-e", path]);
  const sourceLabel = sources.join(", ");
  const processEnv = { ...process.env, ...env };
  delete processEnv.PI_PACKAGE_DIR;
  const result = spawnSync(
    process.execPath,
    // Keep built-in and auto-discovered extensions out; -e still loads the
    // requested shims/package and their declared or discovered resources.
    [getPiRuntime().cli, "--mode", "rpc", "--no-session", "--no-extensions", ...sourceArgs],
    {
      cwd,
      env: processEnv,
      input: '{"id":"smoke","type":"get_commands"}\n',
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `${sourceLabel} RPC failed (${result.status ?? result.signal ?? "spawn error"})`,
        result.error?.stack,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"),
    );
  }

  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const extensionErrors = events.filter((event) => event.type === "extension_error");
  assert.deepEqual(extensionErrors, [], `${sourceLabel} emitted extension_error`);
  const response = events.find((event) => event.id === "smoke" && event.type === "response");
  assert.ok(response, `${sourceLabel} did not answer get_commands`);
  assert.equal(response.success, true, `${sourceLabel} returned an unsuccessful RPC response`);
  return response.data.commands;
}
