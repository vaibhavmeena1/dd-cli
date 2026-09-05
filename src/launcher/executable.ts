import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve, sep } from "node:path";

import type { HarnessRegistration } from "./contracts.ts";
import { LauncherError } from "./errors.ts";
import { LAUNCHER_EXIT_STATUS } from "./exit-status.ts";

const PATH_ENVIRONMENT_VARIABLE = "PATH";

export interface ResolvedExecutable {
  readonly path: string;
  readonly source: "override" | "path";
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const fileStatus = await stat(path);
    if (!fileStatus.isFile()) {
      return false;
    }

    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatePaths(
  candidate: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): readonly string[] {
  if (isAbsolute(candidate) || candidate.includes(sep)) {
    return [resolve(cwd, candidate)];
  }

  const searchPath = environment[PATH_ENVIRONMENT_VARIABLE];
  if (searchPath === undefined) {
    return [];
  }

  return searchPath.split(delimiter).map((directory) => resolve(directory || cwd, candidate));
}

export async function resolveExecutablePath(
  registration: HarnessRegistration,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ResolvedExecutable> {
  const override = environment[registration.executableOverrideVariable];

  if (override !== undefined) {
    if (override.length === 0) {
      throw new LauncherError(
        `${registration.executableOverrideVariable} is set but empty`,
        LAUNCHER_EXIT_STATUS.executableUnavailable,
        {
          remediation: `Set ${registration.executableOverrideVariable} to an executable path or unset it.`,
        },
      );
    }

    const overridePath = resolve(cwd, override);
    if (await isExecutableFile(overridePath)) {
      return Object.freeze({ path: overridePath, source: "override" });
    }

    throw new LauncherError(
      `${registration.id} executable override is not an executable file: ${overridePath}`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      {
        remediation: `Fix ${registration.executableOverrideVariable} or unset it to search PATH.`,
      },
    );
  }

  for (const candidate of registration.executableCandidates) {
    for (const path of candidatePaths(candidate, environment, cwd)) {
      if (await isExecutableFile(path)) {
        return Object.freeze({ path, source: "path" });
      }
    }
  }

  throw new LauncherError(
    `${registration.id} executable is unavailable (tried: ${registration.executableCandidates.join(", ")})`,
    LAUNCHER_EXIT_STATUS.executableUnavailable,
    {
      remediation: `Install ${registration.id} or set ${registration.executableOverrideVariable} to an executable path.`,
    },
  );
}

export async function resolveCommandOnPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | undefined> {
  for (const path of candidatePaths(command, environment, cwd)) {
    if (await isExecutableFile(path)) {
      return path;
    }
  }

  return undefined;
}
