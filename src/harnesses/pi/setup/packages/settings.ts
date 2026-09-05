import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeConfiguredPackageIdentity } from "./manifest.ts";

export type PiSettingsObject = Record<string, unknown>;
export type PiPackageSetting = string | ({ readonly source: string } & Record<string, unknown>);
type PiSettingsFile = PiSettingsObject & { readonly packages?: unknown };
type PossiblePackageSetting = PiSettingsObject & { readonly source?: unknown };

export interface PiSettingsSnapshot {
  readonly config: PiSettingsObject;
  readonly exists: boolean;
  readonly fileMode: number;
  readonly packages: readonly unknown[];
  readonly path: string;
}

const DEFAULT_FILE_MODE = 0o600;

function isJsonObject(value: unknown): value is PiSettingsObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function piSettingsPath(piAgentDirectory: string): string {
  return join(piAgentDirectory, "settings.json");
}

export function packageSettingSource(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (isJsonObject(value)) {
    const setting = value as PossiblePackageSetting;
    return typeof setting.source === "string" ? setting.source : undefined;
  }
  return undefined;
}

export async function readPiSettings(path: string): Promise<PiSettingsSnapshot> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Pi settings path is not a regular file: ${path}`);
    }
    const parsedValue = JSON.parse(await Bun.file(path).text()) as unknown;
    if (!isJsonObject(parsedValue)) {
      throw new Error(`Pi settings top level is not an object: ${path}`);
    }
    const parsed = parsedValue as PiSettingsFile;
    if (parsed.packages !== undefined && !Array.isArray(parsed.packages)) {
      throw new Error(`Pi settings packages field is not an array: ${path}`);
    }
    return {
      config: parsed,
      exists: true,
      fileMode: status.mode & 0o777,
      packages: parsed.packages ?? [],
      path,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        config: {},
        exists: false,
        fileMode: DEFAULT_FILE_MODE,
        packages: [],
        path,
      };
    }
    throw new Error(`could not inspect Pi settings: ${path}`, { cause: error });
  }
}

export function findPackageSetting(
  settings: PiSettingsSnapshot,
  identity: string,
): unknown | undefined {
  return settings.packages.find((entry) => {
    const source = packageSettingSource(entry);
    return source !== undefined && normalizeConfiguredPackageIdentity(source) === identity;
  });
}

export function isUnmodifiedManagedSetting(
  settings: PiSettingsSnapshot,
  identity: string,
  configuredSource: string,
): boolean {
  const matches = settings.packages.filter((entry) => {
    const source = packageSettingSource(entry);
    return source !== undefined && normalizeConfiguredPackageIdentity(source) === identity;
  });
  return matches.length === 1 && matches[0] === configuredSource;
}

export function reconcilePackageSettings(
  settings: PiSettingsSnapshot,
  desiredSources: ReadonlyMap<string, string>,
  removedIdentities: ReadonlySet<string> = new Set(),
): { readonly changed: boolean; readonly config: PiSettingsObject } {
  const seenDesired = new Set<string>();
  const packages: unknown[] = [];

  for (const entry of settings.packages) {
    const source = packageSettingSource(entry);
    const identity = source === undefined ? undefined : normalizeConfiguredPackageIdentity(source);
    if (identity !== undefined && removedIdentities.has(identity)) {
      continue;
    }

    const desiredSource = identity === undefined ? undefined : desiredSources.get(identity);
    if (desiredSource === undefined) {
      packages.push(entry);
      continue;
    }
    if (!seenDesired.has(identity as string)) {
      packages.push(desiredSource);
      seenDesired.add(identity as string);
    }
  }

  for (const [identity, source] of desiredSources) {
    if (!seenDesired.has(identity)) {
      packages.push(source);
    }
  }

  const config = { ...settings.config, packages };
  const changed = JSON.stringify(settings.config) !== JSON.stringify(config);
  return { changed, config };
}

export async function writePiSettings(
  settings: PiSettingsSnapshot,
  config: PiSettingsObject,
): Promise<void> {
  await mkdir(dirname(settings.path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${settings.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
    await chmod(temporaryPath, settings.fileMode);
    await rename(temporaryPath, settings.path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
