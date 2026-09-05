import type { HarnessAdapter } from "../../launcher/contracts.ts";
import { createHarnessEnvironment } from "../../launcher/environment.ts";

export function createOpenCodeAdapter(): HarnessAdapter {
  const adapter: HarnessAdapter = {
    id: "opencode",
    prepare: () => Promise.resolve(),
    buildLaunchSpec: (context, userArguments) =>
      Promise.resolve(
        Object.freeze({
          executable: context.executable,
          arguments: [...userArguments],
          environment: createHarnessEnvironment(context.environment),
          cwd: context.cwd,
        }),
      ),
    doctor: () => Promise.resolve(Object.freeze([])),
  };

  return Object.freeze(adapter);
}
