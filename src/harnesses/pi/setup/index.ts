import type { HarnessLaunchContext } from "../../../launcher/contracts.ts";
import { isTrue } from "../../../launcher/debug-preview.ts";
import { LauncherError } from "../../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../../product/identity.ts";
import { DEPUTYDEV_MANIFEST, EMBEDDED_PI_RESOURCES } from "../../../product/manifest.ts";
import { synchronizePiMcpConfig } from "./mcp-config.ts";
import { classifyPiInvocation } from "./packages/invocation.ts";
import { synchronizePiPackages } from "./packages/sync.ts";
import { materializePiResources } from "./resources.ts";

const DEBUG_ENVIRONMENT_VARIABLE = "DEPUTYDEV_DEBUG";

interface PiSetupCheckResult {
  readonly summary: string;
  readonly warning?: string;
}

interface PiSetupCheck {
  readonly id: string;
  run(context: HarnessLaunchContext): Promise<PiSetupCheckResult>;
}

const PI_SETUP_CHECKS: readonly PiSetupCheck[] = Object.freeze([
  {
    id: "mcp-config",
    async run(context) {
      const syncResult = await synchronizePiMcpConfig({
        environment: context.environment,
      });
      const added =
        syncResult.addedServers.length === 0
          ? "no organization MCP servers added"
          : `added disabled MCP servers: ${syncResult.addedServers.join(", ")}`;

      return {
        summary: `${syncResult.status}; ${added}; path ${syncResult.configPath}`,
        ...(syncResult.warning === undefined ? {} : { warning: syncResult.warning }),
      };
    },
  },
]);

function printDebugResult(check: PiSetupCheck, result: PiSetupCheckResult): void {
  console.error(`${PRODUCT_IDENTITY.command}: pi setup ${check.id}: ${result.summary}`);
  if (result.warning !== undefined) {
    console.error(`${PRODUCT_IDENTITY.command}: pi setup ${check.id} warning: ${result.warning}`);
  }
}

async function prepareRequiredResources(
  context: HarnessLaunchContext,
  userArguments: readonly string[],
  debug: boolean,
): Promise<void> {
  const invocationKind = classifyPiInvocation(userArguments);
  if (invocationKind === "administrative") {
    return;
  }

  try {
    const resources = await materializePiResources(context.paths, EMBEDDED_PI_RESOURCES);
    const packages = await synchronizePiPackages({
      allowInstall: invocationKind === "interactive",
      context,
      manifest: DEPUTYDEV_MANIFEST,
    });
    for (const warning of packages.warnings) {
      console.error(`${PRODUCT_IDENTITY.command}: pi package warning: ${warning}`);
    }
    if (debug) {
      console.error(
        `${PRODUCT_IDENTITY.command}: pi resources: ${resources.hash}; packages: ${packages.manifestHash}`,
      );
    }
  } catch (error) {
    if (error instanceof LauncherError) {
      throw error;
    }
    throw new LauncherError(
      "failed to prepare required Pi resources",
      LAUNCHER_EXIT_STATUS.materializationFailure,
      {
        cause: error,
        remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`,
      },
    );
  }
}

export async function preparePiSetup(
  context: HarnessLaunchContext,
  userArguments: readonly string[],
): Promise<void> {
  const debug = isTrue(context.environment[DEBUG_ENVIRONMENT_VARIABLE]);

  await prepareRequiredResources(context, userArguments, debug);

  for (const check of PI_SETUP_CHECKS) {
    try {
      const checkResult = await check.run(context);
      if (debug) {
        printDebugResult(check, checkResult);
      }
    } catch (error) {
      // Organization defaults are additive convenience configuration. A setup
      // check must never prevent Pi from starting or risk replacing user data.
      if (debug) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${PRODUCT_IDENTITY.command}: pi setup ${check.id} failed: ${message}`);
      }
    }
  }
}
