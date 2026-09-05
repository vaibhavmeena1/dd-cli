export type JsonObject = Record<string, unknown>;

export type PiMcpConfigFetch = (input: string, init: RequestInit) => Promise<Response>;

export type PiMcpConfigSyncStatus = "created" | "updated" | "unchanged" | "skipped";

export interface PiMcpConfigSyncResult {
  readonly status: PiMcpConfigSyncStatus;
  readonly configPath: string;
  readonly sourceUrl: string;
  readonly addedServers: readonly string[];
  readonly warning?: string;
}

export interface PiMcpConfigSyncOptions {
  readonly configPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fallbackHome?: string;
  readonly sourceUrl?: string;
  readonly fetchConfig?: PiMcpConfigFetch;
  readonly timeoutMs?: number;
}

export interface RemoteMcpCatalogResult {
  readonly servers?: JsonObject;
  readonly warning?: string;
}
