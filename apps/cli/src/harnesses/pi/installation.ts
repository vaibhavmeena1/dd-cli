import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
  DoctorFinding,
  ExecutableResolutionOptions,
  HarnessRegistration,
  LaunchContext,
} from "../../launcher/contracts.ts";
import { createHarnessEnvironment } from "../../launcher/environment.ts";
import { LauncherError } from "../../launcher/errors.ts";
import {
  isExecutableFile,
  resolveCommandOnPath,
  resolveExecutablePath,
} from "../../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { withFileLock } from "../../launcher/file-lock.ts";
import { compareSemVer, isSemVer, parseFirstSemVer } from "../../launcher/version.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import type { DeputyDevPaths } from "../../product/paths.ts";
import { classifyPiInvocation, isPiOffline } from "./setup/packages/invocation.ts";
import { type PiVersionProber, resolvePiVersion } from "./version.ts";

/** Oldest Pi whose extension API the embedded DeputyDev resources target. */
export const PI_MINIMUM_VERSION = "0.85.0";
/** Exact Pi version DeputyDev installs when Pi is missing or too old. */
export const PI_INSTALL_VERSION = "0.85.1";
export const PI_VERSION_ENVIRONMENT_VARIABLE = "DEPUTYDEV_PI_VERSION";
export const PI_RELEASES_API = "https://pi.dev/api/installer/releases";
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_MINIMUM_NODE_VERSION = "22.19.0";
export const PI_OFFICIAL_INSTALLER_COMMAND = "curl -fsSL https://pi.dev/install.sh | sh";

const ARTIFACT_TIMEOUT_MS = 30_000;
const MAXIMUM_ARTIFACT_BYTES = 8 * 1024 * 1024;
const TOOLCHAIN_PROBE_TIMEOUT_MS = 5_000;

export interface PiToolchain {
  readonly nodePath?: string;
  readonly nodeVersion?: string;
  readonly npmPath?: string;
}

export interface PiNpmCiRequest {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly npmPath: string;
}

export interface PiInstallationDependencies {
  readonly fetchArtifact?: (url: string) => Promise<string>;
  readonly probeToolchain?: (context: LaunchContext) => Promise<PiToolchain>;
  readonly probeVersion?: PiVersionProber;
  readonly runNpmCi?: (request: PiNpmCiRequest) => Promise<void>;
  readonly warn?: (message: string) => void;
}

export interface PiReleaseArtifacts {
  /** `GET <releases>/<version>`: release metadata with first-party tarball integrity. */
  readonly metadata: string;
  readonly packageJson: string;
  readonly packageLock: string;
}

function isMissingExecutableError(error: unknown): error is LauncherError {
  return (
    error instanceof LauncherError &&
    error.exitStatus === LAUNCHER_EXIT_STATUS.executableUnavailable
  );
}

function setupRemediation(): string {
  return `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`;
}

export function resolveConfiguredPiVersion(environment: NodeJS.ProcessEnv): string {
  const configured = (
    Reflect.get(environment, PI_VERSION_ENVIRONMENT_VARIABLE) as string | undefined
  )?.trim();
  const version = configured || PI_INSTALL_VERSION;
  if (!isSemVer(version)) {
    throw new LauncherError(
      `${PI_VERSION_ENVIRONMENT_VARIABLE} is not a valid Pi version: ${JSON.stringify(version)}`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      { remediation: `Set ${PI_VERSION_ENVIRONMENT_VARIABLE} to an exact Pi release version.` },
    );
  }
  return version;
}

export function managedPiDirectory(paths: DeputyDevPaths, version: string): string {
  return join(paths.piRuntime, version);
}

export function managedPiExecutable(paths: DeputyDevPaths, version: string): string {
  return join(managedPiDirectory(paths, version), "node_modules", ".bin", "pi");
}

export function isManagedPiExecutable(paths: DeputyDevPaths, executable: string): boolean {
  return executable.startsWith(`${paths.piRuntime}/`);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Apply the same checks Pi's own managed installer applies before `npm ci`:
 * both artifacts must describe exactly `${PI_PACKAGE_NAME}@${version}` with a
 * lockfile v3 whose resolved entries all carry integrity hashes.
 */
interface ReleasePackageJson {
  readonly version?: unknown;
  readonly dependencies?: unknown;
}

interface ReleaseLockEntry {
  version?: unknown;
  dependencies?: unknown;
  resolved?: unknown;
  integrity?: unknown;
}

interface ReleasePackageLock {
  readonly version?: unknown;
  readonly lockfileVersion?: unknown;
  readonly packages?: unknown;
}

interface ReleaseMetadataPackage {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly tarball?: unknown;
  readonly integrity?: unknown;
}

interface ReleaseMetadata {
  readonly version?: unknown;
  readonly packages?: unknown;
}

function asDependencyMap(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Pi release ${label} is not valid JSON`);
  }
}

/**
 * Apply the checks Pi's own managed installer applies before `npm ci`, then
 * close the gap it leaves open: the published lockfile omits `integrity` for
 * the first-party `@earendil-works` tarballs, while the release metadata
 * carries their SHA-512 hashes. Those hashes are merged into the lockfile so
 * `npm ci` verifies every resolved tarball. Returns the completed lockfile.
 */
export function validatePiReleaseArtifacts(artifacts: PiReleaseArtifacts, version: string): string {
  const parsedPackageJson = parseJson(artifacts.packageJson, "package.json");
  const parsedPackageLock = parseJson(artifacts.packageLock, "package-lock.json");
  const parsedMetadata = parseJson(artifacts.metadata, "metadata");
  if (
    !isJsonObject(parsedPackageJson) ||
    !isJsonObject(parsedPackageLock) ||
    !isJsonObject(parsedMetadata)
  ) {
    throw new Error("Pi release artifacts must be JSON objects");
  }
  const packageJson = parsedPackageJson as ReleasePackageJson;
  const packageLock = parsedPackageLock as ReleasePackageLock;
  const metadata = parsedMetadata as ReleaseMetadata;

  const dependencies = asDependencyMap(packageJson.dependencies);
  if (
    packageJson.version !== version ||
    dependencies === undefined ||
    dependencies[PI_PACKAGE_NAME] !== version
  ) {
    throw new Error(`Pi release package.json must describe ${PI_PACKAGE_NAME}@${version}`);
  }
  if (packageLock.lockfileVersion !== 3) {
    throw new Error("Pi release package-lock.json must use lockfileVersion 3");
  }
  if (!isJsonObject(packageLock.packages)) {
    throw new Error("Pi release package-lock.json has no packages map");
  }
  const packages = packageLock.packages as Record<string, ReleaseLockEntry | undefined>;
  const root = packages[""];
  const rootDependencies = asDependencyMap(root?.dependencies);
  if (
    packageLock.version !== version ||
    root?.version !== version ||
    rootDependencies === undefined ||
    rootDependencies[PI_PACKAGE_NAME] !== version
  ) {
    throw new Error(
      `Pi release package-lock.json root must describe ${PI_PACKAGE_NAME}@${version}`,
    );
  }
  if (packages[`node_modules/${PI_PACKAGE_NAME}`]?.version !== version) {
    throw new Error(`Pi release package-lock.json does not include ${PI_PACKAGE_NAME}@${version}`);
  }

  if (metadata.version !== version || !Array.isArray(metadata.packages)) {
    throw new Error(`Pi release metadata must describe version ${version}`);
  }
  for (const candidate of metadata.packages as readonly unknown[]) {
    if (!isJsonObject(candidate)) {
      continue;
    }
    const published = candidate as ReleaseMetadataPackage;
    if (
      typeof published.name !== "string" ||
      typeof published.tarball !== "string" ||
      typeof published.integrity !== "string" ||
      published.integrity === ""
    ) {
      continue;
    }
    const entry = packages[`node_modules/${published.name}`];
    if (
      entry !== undefined &&
      typeof entry === "object" &&
      entry.integrity === undefined &&
      entry.resolved === published.tarball &&
      entry.version === published.version
    ) {
      entry.integrity = published.integrity;
    }
  }

  for (const [path, entry] of Object.entries(packages)) {
    if (path === "" || entry === undefined || typeof entry !== "object") {
      continue;
    }
    if (typeof entry.resolved === "string" && typeof entry.integrity !== "string") {
      throw new Error(`Pi release package-lock.json entry lacks an integrity hash: ${path}`);
    }
  }

  return `${JSON.stringify(packageLock, null, 2)}\n`;
}

async function fetchReleaseArtifact(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_ARTIFACT_BYTES) {
    throw new Error(`${url} is larger than the allowed ${MAXIMUM_ARTIFACT_BYTES} bytes`);
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_ARTIFACT_BYTES) {
    throw new Error(`${url} is larger than the allowed ${MAXIMUM_ARTIFACT_BYTES} bytes`);
  }
  return body;
}

async function captureVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const subprocess = Bun.spawn([executable, "--version"], {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: TOOLCHAIN_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      subprocess.exited,
    ]);
    return exitCode === 0 ? parseFirstSemVer(stdout) : undefined;
  } catch {
    return undefined;
  }
}

async function probeInstalledToolchain(context: LaunchContext): Promise<PiToolchain> {
  const environment = createHarnessEnvironment(context.environment);
  const [nodePath, npmPath] = await Promise.all([
    resolveCommandOnPath("node", context.environment, context.cwd),
    resolveCommandOnPath("npm", context.environment, context.cwd),
  ]);
  const nodeVersion =
    nodePath === undefined ? undefined : await captureVersion(nodePath, environment);
  return {
    ...(nodePath === undefined ? {} : { nodePath }),
    ...(nodeVersion === undefined ? {} : { nodeVersion }),
    ...(npmPath === undefined ? {} : { npmPath }),
  };
}

async function runNpmCi(request: PiNpmCiRequest): Promise<void> {
  const subprocess = Bun.spawn(
    [
      request.npmPath,
      "ci",
      "--ignore-scripts",
      "--min-release-age=0",
      "--omit=dev",
      "--include=optional",
      "--no-fund",
      "--no-audit",
      "--progress=false",
      "--loglevel=error",
    ],
    {
      cwd: request.cwd,
      env: request.environment,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await subprocess.exited;
  if (subprocess.signalCode !== null) {
    throw new Error(`npm ci terminated by signal ${subprocess.signalCode}`);
  }
  if (exitCode !== 0) {
    throw new Error(`npm ci exited with status ${exitCode}`);
  }
}

async function verifyManagedInstall(directory: string, version: string): Promise<boolean> {
  try {
    const packageJsonPath = join(directory, "node_modules", PI_PACKAGE_NAME, "package.json");
    const status = await lstat(packageJsonPath);
    if (!status.isFile() || status.isSymbolicLink()) {
      return false;
    }
    const parsed = JSON.parse(await Bun.file(packageJsonPath).text()) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
    if (parsed.name !== PI_PACKAGE_NAME || parsed.version !== version) {
      return false;
    }
    return await isExecutableFile(join(directory, "node_modules", ".bin", "pi"));
  } catch {
    return false;
  }
}

function toolchainFailure(toolchain: PiToolchain): LauncherError {
  const problem =
    toolchain.nodePath === undefined
      ? "Node.js is not installed"
      : toolchain.nodeVersion === undefined
        ? "the Node.js version could not be determined"
        : compareSemVer(toolchain.nodeVersion, PI_MINIMUM_NODE_VERSION) < 0
          ? `Node.js ${toolchain.nodeVersion} is older than ${PI_MINIMUM_NODE_VERSION}`
          : "npm is not installed";
  return new LauncherError(
    `cannot install Pi ${PI_INSTALL_VERSION}: ${problem}`,
    LAUNCHER_EXIT_STATUS.unsupportedEnvironment,
    {
      remediation:
        `Install Node.js ${PI_MINIMUM_NODE_VERSION} or newer and npm (for example: brew install node), ` +
        `or run the official installer (${PI_OFFICIAL_INSTALLER_COMMAND}), which can install Node.js interactively, ` +
        `then rerun ${PRODUCT_IDENTITY.command} pi.`,
    },
  );
}

async function installManagedPi(
  context: LaunchContext,
  version: string,
  dependencies: PiInstallationDependencies,
): Promise<string> {
  const toolchain = await (dependencies.probeToolchain ?? probeInstalledToolchain)(context);
  if (
    toolchain.nodeVersion === undefined ||
    toolchain.npmPath === undefined ||
    compareSemVer(toolchain.nodeVersion, PI_MINIMUM_NODE_VERSION) < 0
  ) {
    throw toolchainFailure(toolchain);
  }

  console.error(`${PRODUCT_IDENTITY.command}: installing Pi ${version}...`);
  const fetchArtifact = dependencies.fetchArtifact ?? fetchReleaseArtifact;
  const releaseUrl = `${PI_RELEASES_API}/${encodeURIComponent(version)}`;
  const targetDirectory = managedPiDirectory(context.paths, version);
  await mkdir(context.paths.piRuntime, { recursive: true, mode: 0o700 });
  const stageDirectory = join(
    context.paths.piRuntime,
    `.staging-${process.pid}-${crypto.randomUUID()}`,
  );

  try {
    const [metadata, packageJson, packageLock] = await Promise.all([
      fetchArtifact(releaseUrl),
      fetchArtifact(`${releaseUrl}/package.json`),
      fetchArtifact(`${releaseUrl}/package-lock.json`),
    ]);
    const completedLock = validatePiReleaseArtifacts(
      { metadata, packageJson, packageLock },
      version,
    );

    await mkdir(stageDirectory, { recursive: true, mode: 0o700 });
    await Bun.write(join(stageDirectory, "package.json"), packageJson);
    await Bun.write(join(stageDirectory, "package-lock.json"), completedLock);
    await (dependencies.runNpmCi ?? runNpmCi)({
      cwd: stageDirectory,
      environment: createHarnessEnvironment(context.environment),
      npmPath: toolchain.npmPath,
    });

    const launcher = join(stageDirectory, "node_modules", ".bin", "pi");
    try {
      await chmod(launcher, 0o755);
    } catch {
      // Verification below reports a missing or non-executable launcher.
    }
    if (!(await verifyManagedInstall(stageDirectory, version))) {
      throw new Error(`installed tree does not contain ${PI_PACKAGE_NAME}@${version}`);
    }

    try {
      await rename(stageDirectory, targetDirectory);
    } catch (error) {
      // A racing installer may have activated the same version first.
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof LauncherError) {
      throw error;
    }
    throw new LauncherError(
      `failed to install Pi ${version}`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        cause: error,
        remediation: `Check access to ${PI_RELEASES_API} and the npm registry, then rerun ${PRODUCT_IDENTITY.command} pi.`,
      },
    );
  } finally {
    await rm(stageDirectory, { force: true, recursive: true });
  }

  if (!(await verifyManagedInstall(targetDirectory, version))) {
    throw new LauncherError(
      `Pi ${version} installation completed but could not be verified at ${targetDirectory}`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { remediation: `Remove ${targetDirectory} and rerun ${PRODUCT_IDENTITY.command} pi.` },
    );
  }
  return managedPiExecutable(context.paths, version);
}

async function locateOnPath(
  context: LaunchContext,
  registration: HarnessRegistration,
): Promise<string | undefined> {
  try {
    return (await resolveExecutablePath(registration, context.environment, context.cwd)).path;
  } catch (error) {
    if (isMissingExecutableError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isBelowMinimum(version: string | undefined): boolean {
  return version !== undefined && compareSemVer(version, PI_MINIMUM_VERSION) < 0;
}

/**
 * Executable precedence:
 * 1. `DEPUTYDEV_PI_BIN` is authoritative (warn when below the minimum).
 * 2. A PATH `pi` whose version is at least the minimum, or whose version is
 *    unknown, or when the user forwards Pi administration such as `pi update`.
 * 3. The DeputyDev-managed exact install under `${DEPUTYDEV_HOME}/pi-runtime`,
 *    created on demand with Pi's release API and `npm ci` (never `install.sh`,
 *    which cannot pin a version and needs an interactive terminal).
 */
export async function resolvePiExecutable(
  context: LaunchContext,
  registration: HarnessRegistration,
  options: ExecutableResolutionOptions,
  dependencies: PiInstallationDependencies = {},
): Promise<string> {
  const warn = dependencies.warn ?? ((message: string) => console.error(message));
  const versionOptions =
    dependencies.probeVersion === undefined ? {} : { probe: dependencies.probeVersion };
  const resolveVersion = (executable: string) =>
    resolvePiVersion(executable, context, versionOptions);

  if (context.environment[registration.executableOverrideVariable] !== undefined) {
    const overridePath = (
      await resolveExecutablePath(registration, context.environment, context.cwd)
    ).path;
    const version = await resolveVersion(overridePath);
    if (isBelowMinimum(version)) {
      warn(
        `${PRODUCT_IDENTITY.command}: ${registration.executableOverrideVariable} points at Pi ${version}, older than the supported minimum ${PI_MINIMUM_VERSION}; continuing`,
      );
    }
    return overridePath;
  }

  const installVersion = resolveConfiguredPiVersion(context.environment);
  const onPath = await locateOnPath(context, registration);
  if (onPath !== undefined) {
    const administrative = classifyPiInvocation(options.userArguments) === "administrative";
    const version = administrative ? undefined : await resolveVersion(onPath);
    if (!isBelowMinimum(version)) {
      return onPath;
    }
  }

  const managed = managedPiExecutable(context.paths, installVersion);
  if (
    await verifyManagedInstall(managedPiDirectory(context.paths, installVersion), installVersion)
  ) {
    return managed;
  }

  const reason =
    onPath === undefined
      ? "pi executable is unavailable"
      : `pi at ${onPath} is older than the supported minimum ${PI_MINIMUM_VERSION}`;
  if (!options.allowInstall || isPiOffline(context.environment, options.userArguments)) {
    throw new LauncherError(reason, LAUNCHER_EXIT_STATUS.executableUnavailable, {
      remediation: `Install Pi ${PI_MINIMUM_VERSION} or newer, or run ${PRODUCT_IDENTITY.command} setup pi --sync-packages while online.`,
    });
  }

  return withFileLock(context.paths.piInstallLock, async () => {
    if (
      await verifyManagedInstall(managedPiDirectory(context.paths, installVersion), installVersion)
    ) {
      return managed;
    }
    warn(`${PRODUCT_IDENTITY.command}: ${reason}`);
    return installManagedPi(context, installVersion, dependencies);
  });
}

/** Doctor findings about the managed Pi runtime; never installs anything. */
export async function inspectPiRuntime(context: LaunchContext): Promise<readonly DoctorFinding[]> {
  const version = resolveConfiguredPiVersion(context.environment);
  const directory = managedPiDirectory(context.paths, version);
  if (await verifyManagedInstall(directory, version)) {
    return [{ level: "info", message: `pi: managed install ${version} at ${directory}` }];
  }
  return [
    {
      level: "info",
      message: `pi: no managed install; DeputyDev installs Pi ${version} only when pi is missing or older than ${PI_MINIMUM_VERSION}`,
    },
  ];
}

export { setupRemediation as piSetupRemediation };
