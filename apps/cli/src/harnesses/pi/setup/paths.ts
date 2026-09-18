import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BUILD_INFO } from "../../../build-info.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../../../product/endpoints.ts";

export function resolvePiMcpConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackHome: string = homedir(),
): string {
  const { HOME } = environment;
  const userHome = resolve(HOME?.trim() || fallbackHome);
  return join(userHome, ".config", "mcp", "mcp.json");
}

export function resolvePiMcpConfigSourceUrl(
  serviceOrigin: string = BUILD_INFO.serviceOrigin,
): string {
  return resolveServiceUrl(serviceOrigin, SERVICE_ENDPOINTS.pi.mcpConfig);
}
