import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rtkFiles = ["LICENSE", "index.ts", "metadata.json"];
const metadataKeys = ["schemaVersion", "upstreamRepository", "version", "tag", "commit", "generatorCommand", "upstreamSourcePath", "generatedSourceSha256", "licenseSha256"];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hash = (content) => createHash("sha256").update(content).digest("hex");

export function compareRtkVersions(left, right) {
  assert.match(left, versionPattern);
  assert.match(right, versionPattern);
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function validateRtkFiles(metadata, source, license) {
  assert.deepEqual(Object.keys(metadata).sort(), [...metadataKeys].sort(), "unexpected RTK metadata fields");
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.upstreamRepository, "rtk-ai/rtk");
  assert.match(metadata.version, versionPattern);
  assert.equal(metadata.tag, `v${metadata.version}`);
  assert.match(metadata.commit, /^[0-9a-f]{40}$/);
  assert.equal(metadata.generatorCommand, "rtk init -g --agent pi --no-patch");
  assert.equal(metadata.upstreamSourcePath, "hooks/pi/rtk.ts");
  assert.equal(metadata.generatedSourceSha256, hash(source), "RTK source hash mismatch");
  assert.equal(metadata.licenseSha256, hash(license), "RTK license hash mismatch");
  return metadata;
}

export function readRtkCandidate(directory) {
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), "RTK directory must be a real directory");
  assert.deepEqual(readdirSync(directory).sort(), rtkFiles, "unexpected RTK candidate paths");
  const files = Object.fromEntries(rtkFiles.map((name) => {
    const path = join(directory, name);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "RTK files must be regular files");
    return [name, readFileSync(path)];
  }));
  const metadata = validateRtkFiles(JSON.parse(files["metadata.json"]), files["index.ts"], files.LICENSE);
  return { metadata, files };
}

export function validatePreparedCandidate(candidateDirectory, baseDirectory) {
  const candidate = readRtkCandidate(candidateDirectory);
  const base = readRtkCandidate(baseDirectory);
  const comparison = compareRtkVersions(candidate.metadata.version, base.metadata.version);
  assert.ok(comparison >= 0, "prepared RTK release must not downgrade the repository");
  if (comparison === 0) {
    for (const name of rtkFiles) {
      assert.ok(candidate.files[name].equals(base.files[name]), "same-version RTK provenance or content drift");
    }
  }
  return candidate.metadata;
}

// Called only by Renovate's allowlisted task. No generators, imports from the
// update checkout, downloads, or tests are executed in the PAT-bearing job.
export function applyRtkCandidate(candidateDirectory, repositoryDirectory) {
  const candidate = readRtkCandidate(candidateDirectory);
  for (const path of ["vendor", "vendor/pi-rtk"]) {
    const stat = lstatSync(join(repositoryDirectory, path));
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "RTK destination must not contain symlinks");
  }
  const destination = join(repositoryDirectory, "vendor/pi-rtk");
  for (const name of rtkFiles) {
    const stat = lstatSync(join(destination, name));
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "RTK destination must contain regular files");
  }
  // Renovate has already changed this version. Never apply a different release
  // if GitHub publishes another tag between preparation and dependency lookup.
  const requested = JSON.parse(readFileSync(join(destination, "metadata.json"), "utf8"));
  assert.equal(requested.version, candidate.metadata.version, "prepared RTK version does not match Renovate's selection");
  for (const name of rtkFiles) writeFileSync(join(destination, name), candidate.files[name]);
  return candidate.metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.RTK_CANDIDATE_DIR;
  assert.ok(directory, "RTK_CANDIDATE_DIR is required");
  const metadata = process.argv.includes("--check")
    ? (process.env.RTK_BASE_DIR
      ? validatePreparedCandidate(directory, process.env.RTK_BASE_DIR)
      : readRtkCandidate(directory).metadata)
    : applyRtkCandidate(directory, process.cwd());
  console.log(`Verified RTK ${metadata.version} (${metadata.commit})`);
}
