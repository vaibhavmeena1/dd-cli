import type { EmbeddedOpenCodeResource } from "../../../product/manifest.ts";
import type { NormalizedOpenCodePlugin } from "../../pi/setup/packages/manifest.ts";

/**
 * Everything the launcher needs to enable DeputyDev's OpenCode extensions for
 * one session:
 *
 * - `pluginDirectories` are materialized bundled plugin directories; they go
 *   into the generated configuration as absolute local paths (OpenCode requires
 *   local plugin targets to be directories with a `server` entrypoint).
 * - `pluginSpecifiers` are manifest-declared public packages with the version
 *   policy baked into the specifier; OpenCode resolves and installs them.
 * - `hash` fingerprints the full extension set for content-keyed runtime
 *   directories and the background-service reconciliation state.
 */
export interface OpenCodeExtensionProvisionResult {
  readonly runtimeDirectory: string;
  readonly pluginDirectories: readonly string[];
  readonly pluginSpecifiers: readonly string[];
  readonly hash: string;
}

export interface OpenCodeProvisionOptions {
  readonly resources: readonly EmbeddedOpenCodeResource[];
  readonly publicPlugins: readonly NormalizedOpenCodePlugin[];
}
