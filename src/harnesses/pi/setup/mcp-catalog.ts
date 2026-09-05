import type { JsonObject, PiMcpConfigFetch, RemoteMcpCatalogResult } from "./contracts.ts";

export const PI_MCP_CONFIG_FETCH_TIMEOUT_MS = 700;

const MAXIMUM_REMOTE_CONFIG_BYTES = 1024 * 1024;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateRemoteServers(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error("response top level must be an object");
  }

  const config = value as JsonObject & { mcpServers?: unknown };
  const servers = config.mcpServers;
  if (!isJsonObject(servers)) {
    throw new Error("response mcpServers must be an object");
  }

  for (const [serverName, definition] of Object.entries(servers)) {
    if (serverName.trim() === "") {
      throw new Error("response contains an empty MCP server name");
    }
    if (!isJsonObject(definition)) {
      throw new Error(`response MCP server ${JSON.stringify(serverName)} must be an object`);
    }
  }

  return servers;
}

export async function fetchOrganizationMcpServers(
  sourceUrl: string,
  fetchConfig: PiMcpConfigFetch,
  timeoutMs: number,
): Promise<RemoteMcpCatalogResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetchConfig(sourceUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: abortController.signal,
    });

    if (!response.ok) {
      return { warning: `organization MCP catalog returned HTTP ${response.status}` };
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_REMOTE_CONFIG_BYTES) {
      return { warning: "organization MCP catalog is larger than the allowed 1 MiB" };
    }

    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAXIMUM_REMOTE_CONFIG_BYTES) {
      return { warning: "organization MCP catalog is larger than the allowed 1 MiB" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { warning: "organization MCP catalog is not valid JSON" };
    }

    try {
      return { servers: validateRemoteServers(parsed) };
    } catch (error) {
      return { warning: `organization MCP catalog is invalid: ${describeError(error)}` };
    }
  } catch (error) {
    const message = abortController.signal.aborted
      ? `organization MCP catalog request timed out after ${timeoutMs}ms`
      : `organization MCP catalog could not be fetched: ${describeError(error)}`;
    return { warning: message };
  } finally {
    clearTimeout(timeout);
  }
}
