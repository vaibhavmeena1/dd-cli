import { chmod, link, lstat, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type {
  JsonObject,
  PiMcpConfigSyncOptions,
  PiMcpConfigSyncResult,
  PiMcpConfigSyncStatus,
} from "./contracts.ts";
import { fetchOrganizationMcpServers, PI_MCP_CONFIG_FETCH_TIMEOUT_MS } from "./mcp-catalog.ts";
import { resolvePiMcpConfigPath, resolvePiMcpConfigSourceUrl } from "./paths.ts";

const DEFAULT_FILE_MODE = 0o600;

interface LocalConfigSnapshot {
  readonly config: JsonObject;
  readonly exists: boolean;
  readonly fileMode: number;
  readonly servers: JsonObject;
}

interface LocalConfigInspection {
  readonly snapshot?: LocalConfigSnapshot;
  readonly warning?: string;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLocalConfig(text: string, configPath: string): LocalConfigInspection {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      warning: `left ${configPath} unchanged because it is not valid JSON`,
    };
  }

  if (!isJsonObject(parsed)) {
    return {
      warning: `left ${configPath} unchanged because its top level is not an object`,
    };
  }

  const config = parsed as JsonObject & { mcpServers?: unknown };
  const servers = config.mcpServers;
  if (servers !== undefined && !isJsonObject(servers)) {
    return {
      warning: `left ${configPath} unchanged because mcpServers is not an object`,
    };
  }

  return {
    snapshot: {
      config,
      exists: true,
      fileMode: DEFAULT_FILE_MODE,
      servers: servers ?? {},
    },
  };
}

async function inspectLocalConfig(configPath: string): Promise<LocalConfigInspection> {
  try {
    const status = await lstat(configPath);

    if (!status.isFile() || status.isSymbolicLink()) {
      return {
        warning: `left ${configPath} unchanged because it is not a regular file`,
      };
    }

    const parsed = parseLocalConfig(await Bun.file(configPath).text(), configPath);
    if (parsed.snapshot === undefined) {
      return parsed;
    }

    return {
      snapshot: {
        ...parsed.snapshot,
        fileMode: status.mode & 0o777,
      },
    };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return {
        snapshot: {
          config: { mcpServers: {} },
          exists: false,
          fileMode: DEFAULT_FILE_MODE,
          servers: {},
        },
      };
    }

    return {
      warning: `could not inspect ${configPath}: ${describeError(error)}`,
    };
  }
}

function forceDisabled(definition: unknown): JsonObject {
  if (!isJsonObject(definition)) {
    throw new Error("MCP server definition must be an object");
  }

  return Object.fromEntries([...Object.entries(definition), ["disabled", true]]);
}

function mergeMissingServers(
  localServers: JsonObject,
  remoteServers: JsonObject,
): { readonly servers: JsonObject; readonly addedServers: readonly string[] } {
  const additions: Array<[string, JsonObject]> = [];

  for (const [serverName, definition] of Object.entries(remoteServers)) {
    if (!Object.hasOwn(localServers, serverName)) {
      additions.push([serverName, forceDisabled(definition)]);
    }
  }

  return {
    servers: Object.fromEntries([...Object.entries(localServers), ...additions]),
    addedServers: additions.map(([serverName]) => serverName),
  };
}

async function writeConfig(
  configPath: string,
  config: JsonObject,
  fileMode: number,
  replaceExisting: boolean,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });

  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
    await chmod(temporaryPath, fileMode);
    if (replaceExisting) {
      await rename(temporaryPath, configPath);
    } else {
      // A hard link gives initial creation atomic no-replace behavior. If a user
      // or another launcher won the race, EEXIST leaves their file untouched.
      await link(temporaryPath, configPath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function result(
  status: PiMcpConfigSyncStatus,
  configPath: string,
  sourceUrl: string,
  addedServers: readonly string[],
  warning?: string,
): PiMcpConfigSyncResult {
  return {
    status,
    configPath,
    sourceUrl,
    addedServers,
    ...(warning === undefined ? {} : { warning }),
  };
}

export async function synchronizePiMcpConfig(
  options: PiMcpConfigSyncOptions = {},
): Promise<PiMcpConfigSyncResult> {
  const environment = options.environment ?? process.env;
  const configPath =
    options.configPath ?? resolvePiMcpConfigPath(environment, options.fallbackHome ?? homedir());
  const sourceUrl = options.sourceUrl ?? resolvePiMcpConfigSourceUrl();
  const initialLocal = await inspectLocalConfig(configPath);

  if (initialLocal.snapshot === undefined) {
    return result("skipped", configPath, sourceUrl, [], initialLocal.warning);
  }

  const remote = await fetchOrganizationMcpServers(
    sourceUrl,
    options.fetchConfig ?? globalThis.fetch,
    options.timeoutMs ?? PI_MCP_CONFIG_FETCH_TIMEOUT_MS,
  );

  // Fetching gives an editor or another launcher time to change the file. Read
  // it again before merging so setup does not apply an update to a stale copy.
  const local = await inspectLocalConfig(configPath);
  if (local.snapshot === undefined) {
    return result("skipped", configPath, sourceUrl, [], local.warning);
  }

  if (remote.servers === undefined) {
    if (local.snapshot.exists) {
      return result("unchanged", configPath, sourceUrl, [], remote.warning);
    }

    try {
      await writeConfig(configPath, local.snapshot.config, local.snapshot.fileMode, false);
      return result("created", configPath, sourceUrl, [], remote.warning);
    } catch (error) {
      return result(
        "skipped",
        configPath,
        sourceUrl,
        [],
        `could not create ${configPath}: ${describeError(error)}`,
      );
    }
  }

  const merged = mergeMissingServers(local.snapshot.servers, remote.servers);
  if (local.snapshot.exists && merged.addedServers.length === 0) {
    return result("unchanged", configPath, sourceUrl, []);
  }

  const nextConfig = {
    ...local.snapshot.config,
    mcpServers: merged.servers,
  };

  try {
    await writeConfig(configPath, nextConfig, local.snapshot.fileMode, local.snapshot.exists);
    return result(
      local.snapshot.exists ? "updated" : "created",
      configPath,
      sourceUrl,
      merged.addedServers,
    );
  } catch (error) {
    return result(
      "skipped",
      configPath,
      sourceUrl,
      [],
      `could not write ${configPath}: ${describeError(error)}`,
    );
  }
}
