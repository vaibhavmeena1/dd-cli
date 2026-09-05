import { synchronizePiPackages } from "../../harnesses/pi/setup/packages/sync.ts";
import { materializePiResources } from "../../harnesses/pi/setup/resources.ts";
import { resolveHarnessRegistration } from "../../harnesses/registry.ts";
import type { HarnessLaunchContext } from "../../launcher/contracts.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { resolveExecutablePath } from "../../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import { DEPUTYDEV_MANIFEST, EMBEDDED_PI_RESOURCES } from "../../product/manifest.ts";
import { resolveDeputyDevPaths } from "../../product/paths.ts";

export interface SetupOptions {
  readonly syncPackages?: boolean;
}

export async function runSetup(
  harnessToken: string,
  options: SetupOptions,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<void> {
  if (options.syncPackages !== true) {
    throw new LauncherError("setup requires an explicit operation", LAUNCHER_EXIT_STATUS.usage, {
      remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`,
    });
  }

  const registration = resolveHarnessRegistration(harnessToken);
  if (registration?.id !== "pi") {
    throw new LauncherError(
      `setup currently supports only pi, received: ${harnessToken}`,
      LAUNCHER_EXIT_STATUS.usage,
      { remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.` },
    );
  }

  const executable = await resolveExecutablePath(registration, environment, cwd);
  const context: HarnessLaunchContext = Object.freeze({
    cwd,
    environment,
    executable: executable.path,
    paths: resolveDeputyDevPaths(environment),
    registration,
  });

  const resources = await materializePiResources(context.paths, EMBEDDED_PI_RESOURCES);
  const packages = await synchronizePiPackages({
    allowInstall: true,
    context,
    manifest: DEPUTYDEV_MANIFEST,
  });

  for (const warning of packages.warnings) {
    console.error(`${PRODUCT_IDENTITY.command}: pi package warning: ${warning}`);
  }
  console.log(`Pi resources ready: ${resources.runtimeDirectory}`);
  console.log(
    packages.packages.length === 0
      ? "Pi required packages: none configured"
      : `Pi required packages ready: ${packages.packages.length}`,
  );
}
