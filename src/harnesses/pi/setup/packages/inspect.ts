import { lstat } from "node:fs/promises";

import type { NormalizedPiPackage } from "./manifest.ts";
import { resolveInstalledPackagePath } from "./manifest.ts";

export interface InstalledPackageInspection {
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly satisfiesPolicy: boolean;
  readonly installedVersion?: string;
  readonly installedCommit?: string;
  readonly reason?: string;
}

async function isRegularDirectory(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    return status.isDirectory() && !status.isSymbolicLink();
  } catch {
    return false;
  }
}

async function inspectNpmPackage(
  packageEntry: NormalizedPiPackage,
  path: string,
): Promise<InstalledPackageInspection> {
  try {
    const packageJsonPath = `${path}/package.json`;
    const status = await lstat(packageJsonPath);
    if (!status.isFile() || status.isSymbolicLink()) {
      return {
        path,
        present: true,
        valid: false,
        satisfiesPolicy: false,
        reason: "installed package.json is not a regular file",
      };
    }
    const parsed = JSON.parse(await Bun.file(packageJsonPath).text()) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
    if (parsed.name !== packageEntry.packageName || typeof parsed.version !== "string") {
      return {
        path,
        present: true,
        valid: false,
        satisfiesPolicy: false,
        reason: "installed npm package identity or version is invalid",
      };
    }

    let satisfiesPolicy = true;
    if (packageEntry.versionPolicy.kind === "exact") {
      satisfiesPolicy = parsed.version === packageEntry.versionPolicy.version;
    } else if (packageEntry.versionPolicy.kind === "minimum") {
      satisfiesPolicy = Bun.semver.satisfies(
        parsed.version,
        `>=${packageEntry.versionPolicy.version}`,
      );
    } else {
      satisfiesPolicy = Bun.semver.satisfies(parsed.version, ">=0.0.0-0");
    }

    return {
      path,
      present: true,
      valid: Bun.semver.satisfies(parsed.version, ">=0.0.0-0"),
      satisfiesPolicy,
      installedVersion: parsed.version,
      ...(satisfiesPolicy ? {} : { reason: "installed version does not satisfy policy" }),
    };
  } catch (error) {
    return {
      path,
      present: true,
      valid: false,
      satisfiesPolicy: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readGitCommit(path: string): Promise<string | undefined> {
  try {
    const subprocess = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: path,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2_000,
      killSignal: "SIGKILL",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      subprocess.exited,
    ]);
    const commit = stdout.trim();
    return exitCode === 0 && /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

async function inspectGitPackage(
  packageEntry: NormalizedPiPackage,
  path: string,
): Promise<InstalledPackageInspection> {
  const commit = await readGitCommit(path);
  if (commit === undefined) {
    return {
      path,
      present: true,
      valid: false,
      satisfiesPolicy: false,
      reason: "installed git package HEAD could not be verified",
    };
  }
  const expectedCommit =
    packageEntry.versionPolicy.kind === "exact"
      ? packageEntry.versionPolicy.commit?.toLowerCase()
      : undefined;
  const satisfiesPolicy = expectedCommit === undefined || commit === expectedCommit;
  return {
    path,
    present: true,
    valid: true,
    satisfiesPolicy,
    installedCommit: commit,
    ...(satisfiesPolicy ? {} : { reason: "installed commit does not satisfy policy" }),
  };
}

export async function inspectInstalledPackage(
  packageEntry: NormalizedPiPackage,
  piAgentDirectory: string,
): Promise<InstalledPackageInspection> {
  const path = resolveInstalledPackagePath(packageEntry, piAgentDirectory);
  if (!(await isRegularDirectory(path))) {
    return {
      path,
      present: false,
      valid: false,
      satisfiesPolicy: false,
      reason: "package is not installed",
    };
  }

  return packageEntry.sourceKind === "npm"
    ? inspectNpmPackage(packageEntry, path)
    : inspectGitPackage(packageEntry, path);
}
