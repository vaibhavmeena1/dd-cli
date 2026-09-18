import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { createOpenCodeAdapter } from "../src/harnesses/opencode/adapter.ts";
import {
  buildOpenCodeConfigContent,
  hashOpenCodeConfigContent,
  openCodeStateEnvironmentOverrides,
  parseInheritedConfigContent,
} from "../src/harnesses/opencode/extensions/config.ts";
import type {
  OpenCodeExtensionProvisionResult,
  OpenCodeProvisionOptions,
} from "../src/harnesses/opencode/extensions/contracts.ts";
import { provisionOpenCodeExtensions } from "../src/harnesses/opencode/extensions/provision.ts";
import {
  classifyOpenCodeInvocation,
  withOpenCodeServer,
} from "../src/harnesses/opencode/invocation.ts";
import {
  reconcileOpenCodeService,
  type ServiceRegistration,
  serviceRegistrationPath,
} from "../src/harnesses/opencode/service.ts";
import {
  normalizeOpenCodePlugins,
  parseDeputyDevManifest,
} from "../src/harnesses/pi/setup/packages/manifest.ts";
import { resolveHarnessRegistration } from "../src/harnesses/registry.ts";
import type { HarnessLaunchContext } from "../src/launcher/contracts.ts";
import { resolveDeputyDevPaths } from "../src/product/paths.ts";

const fixtureRoots: string[] = [];

async function fixture(name: string): Promise<{
  readonly context: HarnessLaunchContext;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `ddcli-opencode-extensions-${name}-`));
  fixtureRoots.push(root);
  const environment: NodeJS.ProcessEnv = {
    HOME: join(root, "home"),
    DEPUTYDEV_HOME: join(root, "deputydev"),
  };
  await mkdir(environment["HOME"] as string, { recursive: true });
  const registration = resolveHarnessRegistration("opencode2");
  if (registration === undefined) {
    throw new Error("OpenCode registration is missing");
  }
  return {
    root,
    context: {
      cwd: root,
      environment,
      paths: resolveDeputyDevPaths(environment, environment["HOME"]),
      registration,
      executable: join(root, "opencode2"),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const provision: OpenCodeExtensionProvisionResult = {
  runtimeDirectory: "/deputydev/runtime/opencode",
  pluginDirectories: ["/deputydev/runtime/opencode/core"],
  pluginSpecifiers: ["@example/opencode-plugin@1.2.3"],
  hash: "extension-hash",
};

describe("OpenCode inline extension config", () => {
  test("merges JSONC input, preserves fields, and deduplicates plugin entries", () => {
    const content = buildOpenCodeConfigContent(
      provision,
      `{
        // Existing inline settings remain intact.
        "theme": "user-theme",
        "plugins": [
          "@example/opencode-plugin@1.2.3",
          { "package": "user-plugin", "options": { "enabled": true } },
        ],
      }`,
    );

    expect(JSON.parse(content)).toEqual({
      theme: "user-theme",
      plugins: [
        "/deputydev/runtime/opencode/core",
        "@example/opencode-plugin@1.2.3",
        { package: "user-plugin", options: { enabled: true } },
      ],
    });
    expect(hashOpenCodeConfigContent(content)).toHaveLength(64);
  });

  test("fails rather than discarding malformed inherited config", () => {
    expect(() => parseInheritedConfigContent("{ invalid")).toThrow(
      "OPENCODE_CONFIG_CONTENT contains invalid JSON",
    );
    expect(() => parseInheritedConfigContent("[]")).toThrow(
      "OPENCODE_CONFIG_CONTENT must contain a JSON object",
    );
    expect(() => parseInheritedConfigContent('{"plugins":"not-an-array"}')).toThrow(
      "OPENCODE_CONFIG_CONTENT.plugins must be an array",
    );
  });

  test("isolates only the OpenCode XDG state root", async () => {
    const { context } = await fixture("state");
    expect(openCodeStateEnvironmentOverrides(context.paths)).toEqual({
      XDG_STATE_HOME: context.paths.opencodeStateRoot,
    });
    expect(
      serviceRegistrationPath({
        HOME: context.environment["HOME"],
        XDG_STATE_HOME: context.paths.opencodeStateRoot,
      }),
    ).toBe(join(context.paths.opencodeStateRoot, "opencode", "service.json"));
  });
});

describe("OpenCode invocation policy", () => {
  test("separates reusable, private, hosted, remote, and administrative launches", () => {
    expect(classifyOpenCodeInvocation([]).mode).toBe("shared-session");
    expect(classifyOpenCodeInvocation(["--prompt", "service"]).mode).toBe("shared-session");
    expect(classifyOpenCodeInvocation(["run", "fix it"]).mode).toBe("shared-session");
    expect(classifyOpenCodeInvocation(["mini"]).mode).toBe("shared-session");

    expect(classifyOpenCodeInvocation(["run", "--standalone", "fix it"]).mode).toBe(
      "private-session",
    );
    expect(classifyOpenCodeInvocation(["--standalone", "mini"]).mode).toBe("private-session");
    expect(classifyOpenCodeInvocation(["acp"]).mode).toBe("private-session");
    expect(classifyOpenCodeInvocation(["serve", "--port", "8080"]).mode).toBe("hosted-server");

    expect(classifyOpenCodeInvocation(["run", "--server", "https://example.test"]).mode).toBe(
      "passthrough",
    );
    expect(classifyOpenCodeInvocation(["--server=https://example.test"]).mode).toBe("passthrough");
    expect(classifyOpenCodeInvocation(["service", "status"]).mode).toBe("passthrough");
    expect(classifyOpenCodeInvocation(["run", "--help"]).mode).toBe("passthrough");
    expect(classifyOpenCodeInvocation(["future-command"]).mode).toBe("passthrough");
    expect(classifyOpenCodeInvocation(["run", "--", "--server"]).mode).toBe("shared-session");
  });

  test("routes reusable clients to the reconciled endpoint without losing argv", () => {
    const root = classifyOpenCodeInvocation(["--print-logs"]);
    expect(withOpenCodeServer(root, ["--print-logs"], "http://127.0.0.1:54321")).toEqual([
      "--server=http://127.0.0.1:54321",
      "--print-logs",
    ]);

    const run = classifyOpenCodeInvocation(["--print-logs", "run", "fix it"]);
    expect(
      withOpenCodeServer(run, ["--print-logs", "run", "fix it"], "http://127.0.0.1:54321"),
    ).toEqual(["--print-logs", "run", "--server=http://127.0.0.1:54321", "fix it"]);
  });
});

describe("OpenCode manifest and bundled resources", () => {
  test("normalizes pinned public plugins and rejects mutable git targets", () => {
    const manifest = parseDeputyDevManifest({
      schemaVersion: 1,
      revision: "test",
      pi: { packages: [], resources: [] },
      opencode: {
        plugins: [
          {
            id: "npm-plugin",
            source: "npm:@example/opencode-plugin",
            versionPolicy: { kind: "minimum", version: "1.2.3" },
          },
          {
            id: "git-plugin",
            source: "git:github.com/example/opencode-plugin",
            versionPolicy: { kind: "exact", commit: "a".repeat(40) },
          },
        ],
        resources: [],
      },
    });

    expect(normalizeOpenCodePlugins(manifest).map((entry) => entry.specifier)).toEqual([
      "@example/opencode-plugin@>=1.2.3",
      `git:github.com/example/opencode-plugin#${"a".repeat(40)}`,
    ]);
    expect(() =>
      parseDeputyDevManifest({
        schemaVersion: 1,
        revision: "test",
        pi: { packages: [], resources: [] },
        opencode: {
          plugins: [
            {
              id: "git-plugin",
              source: "git:github.com/example/opencode-plugin",
              versionPolicy: { kind: "floating" },
            },
          ],
          resources: [],
        },
      }),
    ).toThrow("OpenCode git plugins require an exact commit");
  });

  test("materializes bundled plugin directories into a content-keyed runtime", async () => {
    const { context, root } = await fixture("materialize");
    const sourcePath = join(root, "plugin-source.mjs");
    const bytes = 'export default { id: "fixture", setup() {} };\n';
    await Bun.write(sourcePath, bytes);
    const options: OpenCodeProvisionOptions = {
      resources: [
        {
          id: "fixture-resource",
          plugin: "fixture-plugin",
          destination: "index.js",
          sourcePath,
        },
      ],
      publicPlugins: [
        {
          id: "public-plugin",
          sourceKind: "npm",
          specifier: "@example/public-plugin@1.0.0",
          identity: "npm:@example/public-plugin",
        },
      ],
    };

    const first = await provisionOpenCodeExtensions(context.paths, options);
    const second = await provisionOpenCodeExtensions(context.paths, options);

    expect(second).toEqual(first);
    expect(isAbsolute(first.pluginDirectories[0] as string)).toBe(true);
    expect(first.pluginSpecifiers).toEqual(["@example/public-plugin@1.0.0"]);
    expect(await readFile(join(first.pluginDirectories[0] as string, "index.js"), "utf8")).toBe(
      bytes,
    );
    expect(
      JSON.parse(await readFile(join(first.runtimeDirectory, "manifest.json"), "utf8")),
    ).toMatchObject({ kind: "opencode-extensions", hash: first.hash });
  });
});

describe("OpenCode adapter extension flow", () => {
  test("routes reusable sessions to the isolated reconciled service", async () => {
    const { context } = await fixture("adapter-shared");
    context.environment["XDG_CONFIG_HOME"] = "/user/config";
    context.environment["OPENCODE_CONFIG_CONTENT"] = '{"theme":"user-theme"}';
    let reconciledEnvironment: NodeJS.ProcessEnv | undefined;
    let reconciledHash = "";
    const adapter = createOpenCodeAdapter({
      provisionExtensions: async () => provision,
      reconcileService: async (options) => {
        reconciledEnvironment = options.environment;
        reconciledHash = options.configHash;
        return {
          action: "prewarmed",
          registration: {
            url: "http://127.0.0.1:54001",
            pid: 54001,
            password: "service-secret",
          },
        };
      },
    });

    await adapter.prepare(context, ["run", "fix it"]);
    const launch = await adapter.buildLaunchSpec(context, ["run", "fix it"]);
    const inline = launch.environment["OPENCODE_CONFIG_CONTENT"];

    expect(launch.arguments).toEqual(["run", "--server=http://127.0.0.1:54001", "fix it"]);
    expect(launch.environment["XDG_STATE_HOME"]).toBe(context.paths.opencodeStateRoot);
    expect(launch.environment["XDG_CONFIG_HOME"]).toBe("/user/config");
    expect(launch.environment["OPENCODE_PASSWORD"]).toBe("service-secret");
    expect(JSON.parse(inline as string)).toEqual({
      theme: "user-theme",
      plugins: ["/deputydev/runtime/opencode/core", "@example/opencode-plugin@1.2.3"],
    });
    expect(reconciledEnvironment?.["OPENCODE_CONFIG_CONTENT"]).toBe(inline);
    expect(reconciledHash).toBe(hashOpenCodeConfigContent(inline as string));
  });

  test("injects private sessions without reconciling the reusable service", async () => {
    const { context } = await fixture("adapter-private");
    let reconcileCalls = 0;
    const adapter = createOpenCodeAdapter({
      provisionExtensions: async () => provision,
      reconcileService: async () => {
        reconcileCalls += 1;
        throw new Error("must not run");
      },
    });

    const argumentsVector = ["run", "--standalone", "fix it"];
    await adapter.prepare(context, argumentsVector);
    const launch = await adapter.buildLaunchSpec(context, argumentsVector);

    expect(reconcileCalls).toBe(0);
    expect(launch.arguments).toEqual(argumentsVector);
    expect(launch.environment["OPENCODE_CONFIG_CONTENT"]).toBeString();
    expect(launch.environment["XDG_STATE_HOME"]).toBe(context.paths.opencodeStateRoot);
  });

  test("keeps administrative config untouched while isolating its state", async () => {
    const { context } = await fixture("adapter-admin");
    context.environment["OPENCODE_CONFIG_CONTENT"] = "{ intentionally-invalid";
    const adapter = createOpenCodeAdapter({
      provisionExtensions: async () => {
        throw new Error("must not provision");
      },
    });

    await adapter.prepare(context, ["service", "status"]);
    const launch = await adapter.buildLaunchSpec(context, ["service", "status"]);

    expect(launch.arguments).toEqual(["service", "status"]);
    expect(launch.environment["OPENCODE_CONFIG_CONTENT"]).toBe("{ intentionally-invalid");
    expect(launch.environment["XDG_STATE_HOME"]).toBe(context.paths.opencodeStateRoot);
  });

  test("reports malformed inline config with direct remediation", async () => {
    const { context } = await fixture("adapter-config-error");
    context.environment["OPENCODE_CONFIG_CONTENT"] = "{ invalid";
    const adapter = createOpenCodeAdapter({
      provisionExtensions: async () => provision,
    });

    await expect(adapter.prepare(context, ["run", "--standalone"])).rejects.toMatchObject({
      message:
        "failed to prepare required OpenCode extensions: OPENCODE_CONFIG_CONTENT contains invalid JSON",
      remediation: "Fix or unset OPENCODE_CONFIG_CONTENT, then retry.",
    });
  });
});

describe("dedicated OpenCode service reconciliation", () => {
  test("prewarms once and reuses a healthy matching service", async () => {
    const { context } = await fixture("service-current");
    let registration: ServiceRegistration | undefined;
    let starts = 0;
    const readRegistration = async (): Promise<ServiceRegistration | undefined> => registration;
    const probeRegistration = async (candidate: ServiceRegistration): Promise<boolean> =>
      candidate === registration;
    const start = async (): Promise<ServiceRegistration> => {
      starts += 1;
      registration = {
        url: "http://127.0.0.1:51001",
        pid: 51001,
        password: "secret",
      };
      return registration;
    };

    const first = await reconcileOpenCodeService({
      context,
      paths: context.paths,
      environment: {
        ...context.environment,
        XDG_STATE_HOME: context.paths.opencodeStateRoot,
        OPENCODE_CONFIG_CONTENT: '{"plugins":["fixture"]}',
      },
      configHash: "hash-a",
      readRegistration,
      probeRegistration,
      start,
    });
    const second = await reconcileOpenCodeService({
      context,
      paths: context.paths,
      environment: context.environment,
      configHash: "hash-a",
      readRegistration,
      probeRegistration,
      start,
    });

    expect(first.action).toBe("prewarmed");
    expect(second.action).toBe("current");
    expect(starts).toBe(1);
  });

  test("stops and replaces a healthy service when generated config changes", async () => {
    const { context } = await fixture("service-restart");
    let registration: ServiceRegistration | undefined;
    let nextPid = 52001;
    const stopArguments: (readonly string[])[] = [];
    const readRegistration = async (): Promise<ServiceRegistration | undefined> => registration;
    const probeRegistration = async (candidate: ServiceRegistration): Promise<boolean> =>
      candidate === registration;
    const start = async (): Promise<ServiceRegistration> => {
      const pid = nextPid;
      nextPid += 1;
      registration = { url: `http://127.0.0.1:${pid}`, pid, password: "secret" };
      return registration;
    };
    const run = async (request: { readonly arguments: readonly string[] }): Promise<number> => {
      stopArguments.push(request.arguments);
      return 0;
    };
    const base = {
      context,
      paths: context.paths,
      environment: context.environment,
      readRegistration,
      probeRegistration,
      start,
      run,
    };

    await reconcileOpenCodeService({ ...base, configHash: "hash-a" });
    const result = await reconcileOpenCodeService({ ...base, configHash: "hash-b" });

    expect(result.action).toBe("restarted");
    expect(result.registration.pid).toBe(52002);
    expect(stopArguments).toEqual([[context.executable, "service", "stop"]]);
  });

  test("fails rather than launching without extensions when restart fails", async () => {
    const { context } = await fixture("service-failure");
    let registration: ServiceRegistration | undefined;
    const readRegistration = async (): Promise<ServiceRegistration | undefined> => registration;
    const probeRegistration = async (candidate: ServiceRegistration): Promise<boolean> =>
      candidate === registration;
    const start = async (): Promise<ServiceRegistration> => {
      registration = { url: "http://127.0.0.1:53001", pid: 53001 };
      return registration;
    };
    const base = {
      context,
      paths: context.paths,
      environment: context.environment,
      readRegistration,
      probeRegistration,
      start,
    };

    await reconcileOpenCodeService({ ...base, configHash: "hash-a" });
    await expect(
      reconcileOpenCodeService({
        ...base,
        configHash: "hash-b",
        run: async () => 7,
      }),
    ).rejects.toThrow("could not stop the dedicated OpenCode service (exit 7)");
  });
});
