import type { HarnessAdapter } from "../../launcher/contracts.ts";
import { EMBEDDED_PI_RESOURCES } from "../../product/manifest.ts";
import { createPiEnvironment } from "./environment.ts";
import { preparePiSetup } from "./setup/index.ts";
import { inspectPiPackages } from "./setup/packages/doctor.ts";
import { classifyPiInvocation } from "./setup/packages/invocation.ts";
import { createPiResourceArguments } from "./setup/resources.ts";

export function createPiAdapter(): HarnessAdapter {
  const adapter: HarnessAdapter = {
    id: "pi",
    prepare: preparePiSetup,
    buildLaunchSpec: (context, userArguments) =>
      Promise.resolve(
        Object.freeze({
          executable: context.executable,
          arguments:
            classifyPiInvocation(userArguments) === "administrative"
              ? [...userArguments]
              : [
                  ...createPiResourceArguments(context.paths, EMBEDDED_PI_RESOURCES),
                  ...userArguments,
                ],
          environment: createPiEnvironment(context.environment, context.paths),
          cwd: context.cwd,
        }),
      ),
    doctor: inspectPiPackages,
  };

  return Object.freeze(adapter);
}
