import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRuntimeRoot = fileURLToPath(new URL("../smoke-runtime/", import.meta.url));
const piName = "@earendil-works/pi-coding-agent";
const installCommand = "npm --prefix tests/smoke-runtime ci --include=dev --ignore-scripts";

function preflightError(message, cause) {
  return new Error(
    `Pi smoke runtime preflight failed: ${message}\nRun from the repository root:\n  ${installCommand}`,
    { cause },
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw preflightError(`cannot read ${path}`, cause);
  }
}

// Both regression tests and the packed-artifact smoke runner use this runtime,
// never an ambient Pi installation. Accept a root so the preflight itself can
// be tested with dependency-free filesystem fixtures.
export function getPiRuntime(runtimeRoot = defaultRuntimeRoot) {
  const nodeModules = resolve(runtimeRoot, "node_modules");
  const expectedVersion = readJson(join(runtimeRoot, "package.json")).devDependencies?.[piName];
  if (typeof expectedVersion !== "string") {
    throw preflightError(`${piName} must be pinned in tests/smoke-runtime/package.json`);
  }

  const packagePath = join(nodeModules, piName, "package.json");
  const piPackage = readJson(packagePath);
  if (piPackage?.name !== piName || piPackage?.version !== expectedVersion) {
    throw preflightError(`expected ${piName}@${expectedVersion}, found ${piPackage?.name}@${piPackage?.version}`);
  }
  if (typeof piPackage.bin?.pi !== "string") {
    throw preflightError(`${packagePath} does not declare the Pi CLI`);
  }
  const cli = join(nodeModules, piName, piPackage.bin.pi);
  if (!existsSync(cli)) throw preflightError(`missing locked Pi CLI: ${cli}`);

  // createRequire alone can search ancestor/global node_modules directories,
  // even when its package.json anchor does not exist. Check the anchor above
  // and reject resolutions outside this independently installed tree below.
  const runtimeRequire = createRequire(packagePath);
  const installedTree = realpathSync(nodeModules);
  function resolveModule(name) {
    let path;
    try {
      path = runtimeRequire.resolve(name);
    } catch (cause) {
      throw preflightError(`cannot resolve ${name} from the locked Pi runtime`, cause);
    }
    const localPath = relative(installedTree, path);
    if (isAbsolute(localPath) || localPath === ".." || localPath.startsWith(`..${sep}`)) {
      throw preflightError(`refusing ${name} outside the locked Pi runtime: ${path}`);
    }
    return path;
  }

  return { version: piPackage.version, cli, resolve: resolveModule };
}
