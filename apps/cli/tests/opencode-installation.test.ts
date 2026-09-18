import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_OPENCODE_VERSION,
  OPENCODE_INSTALL_URL,
  resolveConfiguredOpenCodeVersion,
  resolveOpenCodeExecutable,
} from "../src/harnesses/opencode/installation.ts";
import { resolveHarnessRegistration } from "../src/harnesses/registry.ts";
import type { HarnessRegistration, LaunchContext } from "../src/launcher/contracts.ts";
import { resolveDeputyDevPaths } from "../src/product/paths.ts";

const fixtureRoots: string[] = [];

async function writeExecutable(path: string): Promise<void> {
  await Bun.write(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

async function createFixture(name: string): Promise<{
  readonly bin: string;
  readonly context: LaunchContext;
  readonly home: string;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `ddcli-opencode-${name}-`));
  fixtureRoots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(bin, { recursive: true })]);
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: bin,
    DEPUTYDEV_HOME: join(root, "deputydev"),
  };
  return {
    root,
    home,
    bin,
    context: {
      cwd: root,
      environment,
      paths: resolveDeputyDevPaths(environment, home),
    },
  };
}

function openCodeRegistration(): HarnessRegistration {
  const registration = resolveHarnessRegistration("opencode2");
  if (registration === undefined) {
    throw new Error("OpenCode registration is missing");
  }
  return registration;
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("OpenCode version policy", () => {
  test("uses a DeputyDev-controlled default and allows an exact override", () => {
    expect(resolveConfiguredOpenCodeVersion({})).toBe(DEFAULT_OPENCODE_VERSION);
    expect(
      resolveConfiguredOpenCodeVersion({ DEPUTYDEV_OPENCODE_VERSION: "0.0.0-beta-20000" }),
    ).toBe("0.0.0-beta-20000");
  });

  test("rejects moving channels and unsafe installer version arguments", () => {
    expect(() =>
      resolveConfiguredOpenCodeVersion({ DEPUTYDEV_OPENCODE_VERSION: "latest" }),
    ).toThrow("not a valid OpenCode version");
    expect(() =>
      resolveConfiguredOpenCodeVersion({ DEPUTYDEV_OPENCODE_VERSION: "1.2.3; echo unsafe" }),
    ).toThrow("not a valid OpenCode version");
  });
});

describe("OpenCode installation fallback", () => {
  test("uses an existing user installation without fetching", async () => {
    const fixture = await createFixture("existing");
    const executable = join(fixture.bin, "opencode2");
    await writeExecutable(executable);
    let fetchCalls = 0;

    const resolved = await resolveOpenCodeExecutable(fixture.context, openCodeRegistration(), {
      fetchInstaller: async () => {
        fetchCalls += 1;
        return "unused";
      },
    });

    expect(resolved).toBe(executable);
    expect(fetchCalls).toBe(0);
  });

  test("fetches the official script, pins the version, and resolves its shim", async () => {
    const fixture = await createFixture("install");
    const requestedUrls: string[] = [];
    let installerRequest:
      | {
          readonly environment: NodeJS.ProcessEnv;
          readonly installScript: string;
          readonly version: string;
        }
      | undefined;

    const resolved = await resolveOpenCodeExecutable(fixture.context, openCodeRegistration(), {
      fetchInstaller: async (url) => {
        requestedUrls.push(url);
        return "#!/usr/bin/env bash\n# official installer fixture\n";
      },
      runInstaller: async (request) => {
        installerRequest = request;
        const installDirectory = join(fixture.home, ".opencode", "bin");
        await mkdir(installDirectory, { recursive: true });
        await writeExecutable(join(installDirectory, "opencode2"));
      },
    });

    expect(requestedUrls).toEqual([OPENCODE_INSTALL_URL]);
    expect(installerRequest).toMatchObject({
      installScript: "#!/usr/bin/env bash\n# official installer fixture\n",
      version: DEFAULT_OPENCODE_VERSION,
    });
    expect(installerRequest?.environment).toBe(fixture.context.environment);
    expect(resolved).toBe(join(fixture.home, ".opencode", "bin", "opencode2"));
  });

  test("honors the configured version when invoking the installer", async () => {
    const fixture = await createFixture("configured-version");
    Reflect.set(fixture.context.environment, "DEPUTYDEV_OPENCODE_VERSION", "0.0.0-beta-22222");
    let requestedVersion = "";

    await resolveOpenCodeExecutable(fixture.context, openCodeRegistration(), {
      fetchInstaller: async () => "#!/usr/bin/env bash\n",
      runInstaller: async (request) => {
        requestedVersion = request.version;
        const installDirectory = join(fixture.home, ".opencode", "bin");
        await mkdir(installDirectory, { recursive: true });
        await writeExecutable(join(installDirectory, "opencode2"));
      },
    });

    expect(requestedVersion).toBe("0.0.0-beta-22222");
  });

  test("does not install over an invalid explicit executable override", async () => {
    const fixture = await createFixture("override");
    Reflect.set(
      fixture.context.environment,
      "DEPUTYDEV_OPENCODE_BIN",
      join(fixture.root, "missing-opencode"),
    );
    let fetchCalls = 0;

    await expect(
      resolveOpenCodeExecutable(fixture.context, openCodeRegistration(), {
        fetchInstaller: async () => {
          fetchCalls += 1;
          return "unused";
        },
      }),
    ).rejects.toMatchObject({ exitStatus: 121 });
    expect(fetchCalls).toBe(0);
  });

  test("fails clearly when the installer exits without an executable", async () => {
    const fixture = await createFixture("missing-after-install");

    await expect(
      resolveOpenCodeExecutable(fixture.context, openCodeRegistration(), {
        fetchInstaller: async () => "#!/usr/bin/env bash\n",
        runInstaller: async () => {},
      }),
    ).rejects.toMatchObject({
      exitStatus: 121,
      message: "OpenCode installation completed but opencode2 is still unavailable",
    });
  });
});
