import type { HarnessAdapter, HarnessLaunchContext } from "../../launcher/contracts.ts";
import { isTrue } from "../../launcher/debug-preview.ts";
import type { EnvironmentOverrides } from "../../launcher/environment.ts";
import { createHarnessEnvironment } from "../../launcher/environment.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { resolveExecutablePath } from "../../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import { DEPUTYDEV_MANIFEST, EMBEDDED_OPENCODE_RESOURCES } from "../../product/manifest.ts";
import { normalizeOpenCodePlugins } from "../pi/setup/packages/manifest.ts";
import {
  hashOpenCodeConfigContent,
  OPENCODE_CONFIG_CONTENT_VARIABLE,
  openCodeEnvironmentOverrides,
  openCodeStateEnvironmentOverrides,
} from "./extensions/config.ts";
import { provisionOpenCodeExtensions } from "./extensions/provision.ts";
import { resolveOpenCodeExecutable } from "./installation.ts";
import {
  classifyOpenCodeInvocation,
  type OpenCodeInvocation,
  withOpenCodeServer,
} from "./invocation.ts";
import { reconcileOpenCodeService, type ServiceRegistration } from "./service.ts";

const DEBUG_ENVIRONMENT_VARIABLE = "DEPUTYDEV_DEBUG";

interface OpenCodeExtensionSetup {
  readonly environmentOverrides: EnvironmentOverrides;
  readonly service?: ServiceRegistration;
}

/**
 * OpenCode V2 has no Pi-style per-launch extension flag. DeputyDev therefore:
 *
 * 1. materializes bundled plugins into an immutable content-keyed directory;
 * 2. adds their absolute directories and manifested packages to
 *    `OPENCODE_CONFIG_CONTENT`;
 * 3. gives OpenCode a DeputyDev-owned XDG state root; and
 * 4. for reusable local sessions, reconciles a dedicated ephemeral-port service
 *    and connects the client to it explicitly.
 *
 * Standalone sessions, ACP, and `serve` inherit the plugin config directly but
 * do not touch the reusable service. Remote, administrative, informational,
 * and unknown invocations receive only the isolated state root.
 */
export interface OpenCodeAdapterDependencies {
  readonly provisionExtensions?: typeof provisionOpenCodeExtensions;
  readonly reconcileService?: typeof reconcileOpenCodeService;
}

export function createOpenCodeAdapter(
  dependencies: OpenCodeAdapterDependencies = {},
): HarnessAdapter {
  let setup: OpenCodeExtensionSetup | undefined;
  const provisionExtensions = dependencies.provisionExtensions ?? provisionOpenCodeExtensions;
  const reconcileService = dependencies.reconcileService ?? reconcileOpenCodeService;

  async function prepareExtensions(
    context: HarnessLaunchContext,
    invocation: OpenCodeInvocation,
  ): Promise<void> {
    const provision = await provisionExtensions(context.paths, {
      resources: EMBEDDED_OPENCODE_RESOURCES,
      publicPlugins: normalizeOpenCodePlugins(DEPUTYDEV_MANIFEST),
    });
    const environmentOverrides = openCodeEnvironmentOverrides(provision, context.environment);
    const configContent = environmentOverrides[OPENCODE_CONFIG_CONTENT_VARIABLE];
    if (configContent === undefined) {
      throw new Error("generated OpenCode extension config is missing");
    }

    let service: ServiceRegistration | undefined;
    if (invocation.reconcilesService) {
      const environment = createHarnessEnvironment(
        context.environment,
        openCodeStateEnvironmentOverrides(context.paths),
        environmentOverrides,
      );
      service = (
        await reconcileService({
          context,
          paths: context.paths,
          environment,
          configHash: hashOpenCodeConfigContent(configContent),
        })
      ).registration;
    }
    setup = { environmentOverrides, ...(service === undefined ? {} : { service }) };
  }

  const adapter: HarnessAdapter = {
    id: "opencode",
    resolveExecutable: async (context, registration, options) =>
      options.allowInstall
        ? resolveOpenCodeExecutable(context, registration)
        : (await resolveExecutablePath(registration, context.environment, context.cwd)).path,
    prepare: async (context, userArguments) => {
      const invocation = classifyOpenCodeInvocation(userArguments);
      if (!invocation.enablesExtensions) {
        return;
      }
      try {
        await prepareExtensions(context, invocation);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (isTrue(context.environment[DEBUG_ENVIRONMENT_VARIABLE])) {
          console.error(`${PRODUCT_IDENTITY.command}: OpenCode extension setup failed: ${detail}`);
        }
        const inlineConfigFailure = detail.startsWith(OPENCODE_CONFIG_CONTENT_VARIABLE);
        throw new LauncherError(
          `failed to prepare required OpenCode extensions: ${detail}`,
          LAUNCHER_EXIT_STATUS.materializationFailure,
          {
            cause: error,
            remediation: inlineConfigFailure
              ? `Fix or unset ${OPENCODE_CONFIG_CONTENT_VARIABLE}, then retry.`
              : `Run ${PRODUCT_IDENTITY.command} doctor opencode.`,
          },
        );
      }
    },
    buildLaunchSpec: (context, userArguments) => {
      const invocation = classifyOpenCodeInvocation(userArguments);
      const extensionSetup = invocation.enablesExtensions ? setup : undefined;
      if (invocation.enablesExtensions && extensionSetup === undefined) {
        return Promise.reject(
          new LauncherError(
            "OpenCode launch was built before extension setup ran",
            LAUNCHER_EXIT_STATUS.materializationFailure,
            { remediation: `Run ${PRODUCT_IDENTITY.command} doctor opencode.` },
          ),
        );
      }
      if (invocation.reconcilesService && extensionSetup?.service === undefined) {
        return Promise.reject(
          new LauncherError(
            "the dedicated OpenCode service is unavailable",
            LAUNCHER_EXIT_STATUS.materializationFailure,
            { remediation: `Run ${PRODUCT_IDENTITY.command} doctor opencode.` },
          ),
        );
      }

      const service = extensionSetup?.service;
      const serviceAuthentication: EnvironmentOverrides =
        service === undefined
          ? {}
          : {
              OPENCODE_PASSWORD: service.password,
              OPENCODE_SERVER_PASSWORD: undefined,
            };
      return Promise.resolve(
        Object.freeze({
          executable: context.executable,
          arguments:
            service === undefined
              ? [...userArguments]
              : withOpenCodeServer(invocation, userArguments, service.url),
          environment: createHarnessEnvironment(
            context.environment,
            openCodeStateEnvironmentOverrides(context.paths),
            extensionSetup?.environmentOverrides ?? {},
            serviceAuthentication,
          ),
          cwd: context.cwd,
        }),
      );
    },
    doctor: () => Promise.resolve(Object.freeze([])),
  };

  return Object.freeze(adapter);
}
