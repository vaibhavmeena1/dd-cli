export type JsonObject = Record<string, unknown>;

export type PiMcpConfigFetch = (input: string, init: RequestInit) => Promise<Response>;

export type PiMcpConfigSyncStatus = "created" | "updated" | "unchanged" | "skipped" | "throttled";

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
  /** Path of the attempt stamp used to throttle catalog requests; omit to disable throttling. */
  readonly stampPath?: string;
  /** Ignore the throttle stamp (explicit `setup`). */
  readonly force?: boolean;
  readonly now?: () => Date;
}

export interface RemoteMcpCatalogResult {
  readonly servers?: JsonObject;
  readonly warning?: string;
}
