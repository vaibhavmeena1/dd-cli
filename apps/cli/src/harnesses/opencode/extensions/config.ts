import type { EnvironmentOverrides } from "../../../launcher/environment.ts";
import type { DeputyDevPaths } from "../../../product/paths.ts";
import type { OpenCodeExtensionProvisionResult } from "./contracts.ts";

export const OPENCODE_CONFIG_CONTENT_VARIABLE = "OPENCODE_CONFIG_CONTENT";
export const XDG_STATE_HOME_VARIABLE = "XDG_STATE_HOME";

interface InheritedConfig {
  readonly plugins: readonly unknown[];
  readonly rest: Record<string, unknown>;
}

/**
 * Parse the caller's inline OpenCode configuration without weakening OpenCode's
 * own validation. OpenCode accepts JSONC here, including comments and trailing
 * commas, so DeputyDev uses Bun's JSONC parser as well.
 */
export function parseInheritedConfigContent(value: string | undefined): InheritedConfig {
  if (value === undefined || value.trim() === "") {
    return { plugins: [], rest: {} };
  }

  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(value);
  } catch (cause) {
    throw new Error(`${OPENCODE_CONFIG_CONTENT_VARIABLE} contains invalid JSON`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${OPENCODE_CONFIG_CONTENT_VARIABLE} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const { plugins, ...rest } = record;
  if (plugins !== undefined && !Array.isArray(plugins)) {
    throw new Error(`${OPENCODE_CONFIG_CONTENT_VARIABLE}.plugins must be an array`);
  }
  return {
    plugins: plugins ?? [],
    rest,
  };
}

/**
 * Build the inline config for one extension-bearing launch.
 *
 * OpenCode merges this source after global and project configuration with array
 * concatenation. DeputyDev entries therefore augment those sources. Existing
 * inline plugin entries remain after DeputyDev's entries so caller-provided
 * transforms retain the final position within the inline source.
 */
export function buildOpenCodeConfigContent(
  provision: OpenCodeExtensionProvisionResult,
  inheritedValue: string | undefined,
): string {
  const inherited = parseInheritedConfigContent(inheritedValue);
  const seen = new Set<string>();
  const entries: unknown[] = [];
  const remember = (entry: unknown): void => {
    const key = typeof entry === "string" ? entry : JSON.stringify(entry);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push(entry);
  };

  for (const entry of [...provision.pluginDirectories, ...provision.pluginSpecifiers]) {
    remember(entry);
  }
  for (const entry of inherited.plugins) {
    remember(entry);
  }
  return JSON.stringify({ ...inherited.rest, plugins: entries });
}

/** Fingerprint the exact inline configuration inherited by the service. */
export function hashOpenCodeConfigContent(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

export function openCodeEnvironmentOverrides(
  provision: OpenCodeExtensionProvisionResult,
  inheritedEnvironment: NodeJS.ProcessEnv,
): EnvironmentOverrides {
  return {
    [OPENCODE_CONFIG_CONTENT_VARIABLE]: buildOpenCodeConfigContent(
      provision,
      inheritedEnvironment[OPENCODE_CONFIG_CONTENT_VARIABLE],
    ),
  };
}

/**
 * Give all OpenCode commands launched through DeputyDev a distinct service
 * registry. Config, auth, data, and cache roots intentionally remain inherited.
 */
export function openCodeStateEnvironmentOverrides(paths: DeputyDevPaths): EnvironmentOverrides {
  return { [XDG_STATE_HOME_VARIABLE]: paths.opencodeStateRoot };
}
