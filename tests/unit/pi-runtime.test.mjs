import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { getPiRuntime } from "../helpers/pi-runtime.mjs";

const piName = "@earendil-works/pi-coding-agent";
const version = "1.2.3";
const installCommand = "npm --prefix tests/smoke-runtime ci --include=dev --ignore-scripts";

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path, value) {
  write(path, JSON.stringify(value));
}

function fixture(t, { installedVersion = version, installed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "tests", "smoke-runtime");
  const piDir = join(runtimeRoot, "node_modules", piName);
  const cli = join(piDir, "dist", "cli.js");
  writeJson(join(runtimeRoot, "package.json"), { devDependencies: { [piName]: version } });
  if (installed) {
    writeJson(join(piDir, "package.json"), {
      name: piName,
      version: installedVersion,
      bin: { pi: "dist/cli.js" },
    });
    write(cli, "");
  }
  return { root, runtimeRoot, piDir, cli };
}

function assertPreflightFailure(run, reason) {
  assert.throws(run, (error) => {
    assert.match(error.message, /^Pi smoke runtime preflight failed:/);
    assert.match(error.message, reason);
    assert.ok(error.message.includes(`Run from the repository root:\n  ${installCommand}`));
    return true;
  });
}

test("resolves nested and hoisted modules only from the installed Pi runtime", (t) => {
  const { runtimeRoot, piDir, cli } = fixture(t);
  const jiti = join(piDir, "node_modules", "jiti", "index.js");
  const tui = join(runtimeRoot, "node_modules", "@earendil-works", "pi-tui", "index.js");
  write(jiti, "");
  write(tui, "");

  const runtime = getPiRuntime(runtimeRoot);
  assert.equal(runtime.version, version);
  assert.equal(runtime.cli, cli);
  assert.equal(runtime.resolve("jiti"), realpathSync(jiti));
  assert.equal(runtime.resolve("@earendil-works/pi-tui"), realpathSync(tui));
});

test("resolves modules when the runtime root is a directory symlink", (t) => {
  const { root, runtimeRoot, piDir } = fixture(t);
  const jiti = join(piDir, "node_modules", "jiti", "index.js");
  write(jiti, "");
  const linkedRoot = join(root, "linked-runtime");
  symlinkSync(runtimeRoot, linkedRoot, "junction");

  assert.equal(getPiRuntime(linkedRoot).resolve("jiti"), realpathSync(jiti));
});

test("a missing runtime fails with installation instructions despite an ambient Pi", (t) => {
  const { root, runtimeRoot } = fixture(t, { installed: false });
  const ambientPi = join(root, "node_modules", piName);
  writeJson(join(ambientPi, "package.json"), { name: piName, version, bin: { pi: "cli.js" } });
  write(join(ambientPi, "cli.js"), "");
  write(join(root, "node_modules", "jiti", "index.js"), "");

  assertPreflightFailure(() => getPiRuntime(runtimeRoot), /cannot read .*package\.json/);
});

test("a stale runtime fails with installation instructions", (t) => {
  const { runtimeRoot } = fixture(t, { installedVersion: "1.2.2" });
  assertPreflightFailure(() => getPiRuntime(runtimeRoot), /expected .*@1\.2\.3, found .*@1\.2\.2/);
});

test("a missing Pi CLI fails with installation instructions", (t) => {
  const { runtimeRoot, cli } = fixture(t);
  rmSync(cli);
  assertPreflightFailure(() => getPiRuntime(runtimeRoot), /missing locked Pi CLI/);
});

test("a runtime without a declared Pi CLI fails with installation instructions", (t) => {
  const { runtimeRoot, piDir } = fixture(t);
  writeJson(join(piDir, "package.json"), { name: piName, version });
  assertPreflightFailure(() => getPiRuntime(runtimeRoot), /does not declare the Pi CLI/);
});

test("missing runtime modules fail with installation instructions", (t) => {
  const { runtimeRoot } = fixture(t);
  const runtime = getPiRuntime(runtimeRoot);
  assertPreflightFailure(
    () => runtime.resolve("pi-distribution-missing-test-dependency"),
    /cannot resolve pi-distribution-missing-test-dependency/,
  );
});

test("runtime module resolution rejects ancestor node_modules fallback", (t) => {
  const { root, runtimeRoot } = fixture(t);
  write(join(root, "node_modules", "jiti", "index.js"), "");
  const runtime = getPiRuntime(runtimeRoot);
  assertPreflightFailure(() => runtime.resolve("jiti"), /refusing jiti outside the locked Pi runtime/);
});
