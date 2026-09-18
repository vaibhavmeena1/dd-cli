import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { HarnessRegistration, LaunchContext } from "../../launcher/contracts.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { resolveExecutablePath } from "../../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { withFileLock } from "../../launcher/file-lock.ts";
import { SEMVER_PATTERN } from "../../launcher/version.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";

export const OPENCODE_INSTALL_URL = "https://opencode.ai/v2/install";
export const OPENCODE_VERSION_ENVIRONMENT_VARIABLE = "DEPUTYDEV_OPENCODE_VERSION";

// DeputyDev always sends an exact version to the upstream installer. Change this
// value as part of a DeputyDev release instead of following OpenCode's live beta
// channel implicitly.
export const DEFAULT_OPENCODE_VERSION = "0.0.0-beta-19086";

const INSTALL_LOCK_NAME = "opencode-install.lock";
const VERSION_PATTERN = SEMVER_PATTERN;

export interface OpenCodeInstallerRequest {
  readonly environment: NodeJS.ProcessEnv;
  readonly installScript: string;
  readonly version: string;
}

export interface OpenCodeInstallationDependencies {
  readonly fetchInstaller?: (url: string) => Promise<string>;
  readonly runInstaller?: (request: OpenCodeInstallerRequest) => Promise<void>;
}

function isMissingExecutableError(error: unknown): error is LauncherError {
  return (
    error instanceof LauncherError &&
    error.exitStatus === LAUNCHER_EXIT_STATUS.executableUnavailable
  );
}

export function resolveConfiguredOpenCodeVersion(environment: NodeJS.ProcessEnv): string {
  const configuredVersion = environment[OPENCODE_VERSION_ENVIRONMENT_VARIABLE]?.trim();
  const version = configuredVersion || DEFAULT_OPENCODE_VERSION;

  if (!VERSION_PATTERN.test(version)) {
    throw new LauncherError(
      `${OPENCODE_VERSION_ENVIRONMENT_VARIABLE} is not a valid OpenCode version: ${JSON.stringify(version)}`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        remediation: `Set ${OPENCODE_VERSION_ENVIRONMENT_VARIABLE} to an exact OpenCode release version.`,
      },
    );
  }

  return version;
}

async function fetchOfficialInstaller(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/x-shellscript, text/plain;q=0.9, */*;q=0.1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`installer request returned HTTP ${response.status}`);
  }

  const installScript = await response.text();
  if (installScript.trim() === "") {
    throw new Error("installer response was empty");
  }
  return installScript;
}

async function runOfficialInstaller(request: OpenCodeInstallerRequest): Promise<void> {
  const subprocess = Bun.spawn(
    ["/usr/bin/env", "bash", "-s", "--", "--version", request.version, "--no-modify-path"],
    {
      env: request.environment,
      stdin: new TextEncoder().encode(request.installScript),
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) {
    throw new Error(`OpenCode installer exited with status ${exitCode}`);
  }
}

function officialOpenCodeBinDirectory(environment: NodeJS.ProcessEnv): string {
  const userHome = (Reflect.get(environment, "HOME") as string | undefined)?.trim() || homedir();
  return join(userHome, ".opencode", "bin");
}

function environmentWithOpenCodeBin(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const binDirectory = officialOpenCodeBinDirectory(environment);
  const currentPath = Reflect.get(environment, "PATH") as string | undefined;
  return {
    ...environment,
    PATH:
      currentPath === undefined || currentPath === ""
        ? binDirectory
        : `${binDirectory}${delimiter}${currentPath}`,
  };
}

async function installOpenCode(
  context: LaunchContext,
  dependencies: OpenCodeInstallationDependencies,
): Promise<void> {
  const version = resolveConfiguredOpenCodeVersion(context.environment);
  const fetchInstaller = dependencies.fetchInstaller ?? fetchOfficialInstaller;
  const runInstaller = dependencies.runInstaller ?? runOfficialInstaller;

  console.error(
    `${PRODUCT_IDENTITY.command}: opencode2 was not found; installing OpenCode ${version}...`,
  );

  try {
    const installScript = await fetchInstaller(OPENCODE_INSTALL_URL);
    await runInstaller({
      environment: context.environment,
      installScript,
      version,
    });
  } catch (error) {
    throw new LauncherError(
      `failed to install OpenCode ${version}`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        cause: error,
        remediation: `Check access to ${OPENCODE_INSTALL_URL}, then rerun ${PRODUCT_IDENTITY.command} opencode2.`,
      },
    );
  }
}

export async function resolveOpenCodeExecutable(
  context: LaunchContext,
  registration: HarnessRegistration,
  dependencies: OpenCodeInstallationDependencies = {},
): Promise<string> {
  try {
    return (await resolveExecutablePath(registration, context.environment, context.cwd)).path;
  } catch (error) {
    // An explicit override is authoritative. Never hide an invalid override by
    // downloading another executable.
    if (
      !isMissingExecutableError(error) ||
      context.environment[registration.executableOverrideVariable] !== undefined
    ) {
      throw error;
    }
  }

  return withFileLock(join(context.paths.locks, INSTALL_LOCK_NAME), async () => {
    const lookupEnvironment = environmentWithOpenCodeBin(context.environment);

    // Another process, or an earlier upstream installation whose bin directory
    // is not on PATH yet, may already have made opencode2 available.
    try {
      return (await resolveExecutablePath(registration, lookupEnvironment, context.cwd)).path;
    } catch (error) {
      if (!isMissingExecutableError(error)) {
        throw error;
      }
    }

    await installOpenCode(context, dependencies);

    try {
      return (await resolveExecutablePath(registration, lookupEnvironment, context.cwd)).path;
    } catch (error) {
      if (!isMissingExecutableError(error)) {
        throw error;
      }
      throw new LauncherError(
        "OpenCode installation completed but opencode2 is still unavailable",
        LAUNCHER_EXIT_STATUS.executableUnavailable,
        {
          cause: error,
          remediation: `Add ${officialOpenCodeBinDirectory(context.environment)} to PATH or set ${registration.executableOverrideVariable}.`,
        },
      );
    }
  });
}
