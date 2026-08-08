import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstreamRepository = "rtk-ai/rtk";
const upstreamSourcePath = "hooks/pi/rtk.ts";
const generatorCommand = "rtk init -g --agent pi --no-patch";
const rtkBin = process.env.RTK_BIN || "rtk";
const generatorEnvironment = { ...process.env };
for (const name of [
  "GITHUB_TOKEN",
  "RTK_GITHUB_TOKEN",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STEP_SUMMARY",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_RUNTIME_URL",
  "ACTIONS_CACHE_URL",
]) {
  delete generatorEnvironment[name];
}
const tempRoot = mkdtempSync(join(tmpdir(), "pi-distribution-update-pi-rtk-"));
const home = join(tempRoot, "home");

function fail(message, details = "") {
  throw new Error([message, details].filter(Boolean).join("\n"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "spawn error"})`,
      [result.error?.stack, result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
  }
  return result;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function atomicWrite(relativePath, content) {
  const destination = join(root, relativePath);
  if (existsSync(destination) && readFileSync(destination).equals(content)) return false;
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${process.pid}`);
  writeFileSync(temporary, content);
  renameSync(temporary, destination);
  return true;
}

function githubHeaders(accept = "application/vnd.github+json") {
  const headers = {
    Accept: accept,
    "User-Agent": "pi-distribution-update-pi-rtk",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.RTK_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchRequired(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) fail(`request failed: ${response.status} ${response.statusText}`, url);
  return response;
}

async function fetchJson(url) {
  return fetchRequired(url, { headers: githubHeaders() }).then((response) => response.json());
}

async function resolveTagCommit(tag) {
  if (process.env.RTK_UPSTREAM_COMMIT) {
    assert.match(process.env.RTK_UPSTREAM_COMMIT, /^[0-9a-f]{40}$/);
    return process.env.RTK_UPSTREAM_COMMIT;
  }

  const encodedTag = tag
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  let object = (
    await fetchJson(`https://api.github.com/repos/${upstreamRepository}/git/ref/tags/${encodedTag}`)
  ).object;

  for (let depth = 0; depth < 8 && object.type === "tag"; depth += 1) {
    object = (await fetchJson(`https://api.github.com/repos/${upstreamRepository}/git/tags/${object.sha}`))
      .object;
  }
  if (object.type !== "commit" || !/^[0-9a-f]{40}$/.test(object.sha)) {
    fail(`upstream ${tag} did not resolve to a commit`, JSON.stringify(object));
  }
  return object.sha;
}

async function readUpstreamFile(commit, relativePath) {
  if (process.env.RTK_UPSTREAM_DIR) {
    return readFileSync(resolve(process.env.RTK_UPSTREAM_DIR, relativePath));
  }
  const url = `https://raw.githubusercontent.com/${upstreamRepository}/${commit}/${relativePath}`;
  return Buffer.from(await (await fetchRequired(url, { headers: githubHeaders("application/octet-stream") })).arrayBuffer());
}

try {
  mkdirSync(home, { recursive: true });

  const versionResult = run(rtkBin, ["--version"], { env: generatorEnvironment });
  const versionMatch = versionResult.stdout.trim().match(/^rtk\s+(\d+\.\d+\.\d+)$/);
  if (!versionMatch) fail(`could not parse RTK version from ${JSON.stringify(versionResult.stdout.trim())}`);
  const version = versionMatch[1];
  const tag = `v${version}`;
  const commit = await resolveTagCommit(tag);

  run(rtkBin, ["init", "-g", "--agent", "pi", "--no-patch"], {
    env: {
      ...generatorEnvironment,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    },
  });

  const generatedPath = join(home, ".pi", "agent", "extensions", "rtk.ts");
  if (!existsSync(generatedPath)) fail(`RTK did not generate ${generatedPath}`);

  const generatedSource = readFileSync(generatedPath);
  const [upstreamSource, upstreamLicense] = await Promise.all([
    readUpstreamFile(commit, upstreamSourcePath),
    readUpstreamFile(commit, "LICENSE"),
  ]);
  if (!generatedSource.equals(upstreamSource)) {
    fail(
      `generated pi-rtk source differs from ${upstreamRepository}/${upstreamSourcePath}@${commit}`,
      `generated sha256=${sha256(generatedSource)} upstream sha256=${sha256(upstreamSource)}`,
    );
  }

  const metadata = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        upstreamRepository,
        version,
        tag,
        commit,
        generatorCommand,
        upstreamSourcePath,
        generatedSourceSha256: sha256(generatedSource),
        licenseSha256: sha256(upstreamLicense),
      },
      null,
      2,
    )}\n`,
  );

  const changed = [
    atomicWrite("vendor/pi-rtk/index.ts", generatedSource),
    atomicWrite("vendor/pi-rtk/LICENSE", upstreamLicense),
    atomicWrite("vendor/pi-rtk/metadata.json", metadata),
  ].filter(Boolean).length;

  console.log(
    changed === 0
      ? `pi-rtk is already synchronized with RTK ${version} (${commit})`
      : `updated ${changed} pi-rtk artifact file(s) from RTK ${version} (${commit})`,
  );
} finally {
  if (process.env.KEEP_PI_RTK_TMP === "1") {
    console.log(`kept pi-rtk update directory: ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
