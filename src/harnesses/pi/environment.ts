import { createHarnessEnvironment, type EnvironmentOverrides } from "../../launcher/environment.ts";
import type { DeputyDevPaths } from "../../product/paths.ts";

const PI_PROCESS_OVERRIDES = Object.freeze({
  PI_SKIP_VERSION_CHECK: "1",
}) satisfies EnvironmentOverrides;

const PI_PROVIDER_CREDENTIAL_REMOVALS = Object.freeze({
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
}) satisfies EnvironmentOverrides;

function createPiDirectoryOverrides(paths: DeputyDevPaths): EnvironmentOverrides {
  return Object.freeze({
    PI_CODING_AGENT_DIR: paths.pi,
    PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
  });
}

export function createPiEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
  paths: DeputyDevPaths,
): NodeJS.ProcessEnv {
  return createHarnessEnvironment(
    inheritedEnvironment,
    createPiDirectoryOverrides(paths),
    PI_PROCESS_OVERRIDES,
    PI_PROVIDER_CREDENTIAL_REMOVALS,
  );
}
