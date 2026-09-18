import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  managedPiExecutable,
  PI_INSTALL_VERSION,
  PI_MINIMUM_VERSION,
  PI_PACKAGE_NAME,
  PI_RELEASES_API,
  type PiReleaseArtifacts,
  type PiToolchain,
  resolveConfiguredPiVersion,
  resolvePiExecutable,
  validatePiReleaseArtifacts,
} from "../src/harnesses/pi/installation.ts";
import { resolvePiVersion } from "../src/harnesses/pi/version.ts";
import { resolveHarnessRegistration } from "../src/harnesses/registry.ts";
import type { HarnessRegistration, LaunchContext } from "../src/launcher/contracts.ts";
import { resolveDeputyDevPaths } from "../src/product/paths.ts";

const fixtureRoots: string[] = [];

async function writePi(path: string, version: string): Promise<void> {
  await Bun.write(path, `#!/bin/sh\necho "${version}"\n`);
  await chmod(path, 0o755);
}

async function createFixture(name: string): Promise<{
  readonly bin: string;
  readonly context: LaunchContext;
  readonly home: string;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `ddcli-pi-install-${name}-`));
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

function piRegistration(): HarnessRegistration {
  const registration = resolveHarnessRegistration("pi");
  if (registration === undefined) {
    throw new Error("Pi registration is missing");
  }
  return registration;
}

const PI_TARBALL_INTEGRITY = "sha512-first-party-fixture";

function releaseArtifacts(version: string): PiReleaseArtifacts {
  const piEntry = `node_modules/${PI_PACKAGE_NAME}`;
  const tarball = `https://registry.npmjs.org/${PI_PACKAGE_NAME}/-/pi-coding-agent-${version}.tgz`;
  return {
    // Like the live API: first-party tarball hashes live in the metadata, not the lockfile.
    metadata: JSON.stringify({
      schemaVersion: 1,
      version,
      packages: [{ name: PI_PACKAGE_NAME, version, tarball, integrity: PI_TARBALL_INTEGRITY }],
    }),
    packageJson: JSON.stringify({
      name: "pi-managed-install",
      version,
      dependencies: { [PI_PACKAGE_NAME]: version },
    }),
    packageLock: JSON.stringify({
      name: "pi-managed-install",
      version,
      lockfileVersion: 3,
      packages: {
        "": { version, dependencies: { [PI_PACKAGE_NAME]: version } },
        [piEntry]: { version, resolved: tarball },
        "node_modules/third-party": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/third-party/-/third-party-1.0.0.tgz",
          integrity: "sha512-third-party-fixture",
        },
      },
    }),
  };
}

const healthyToolchain: PiToolchain = {
  nodePath: "/fixture/node",
  nodeVersion: "22.19.0",
  npmPath: "/fixture/npm",
};

function installerDependencies(fixture: { readonly root: string }, version: string) {
  const state = { fetched: [] as string[], npmRuns: 0, warnings: [] as string[] };
  const dependencies = {
    fetchArtifact: async (url: string) => {
      state.fetched.push(url);
      const artifacts = releaseArtifacts(version);
      if (url.endsWith("/package.json")) {
        return artifacts.packageJson;
      }
      return url.endsWith("/package-lock.json") ? artifacts.packageLock : artifacts.metadata;
    },
    probeToolchain: async () => healthyToolchain,
    runNpmCi: async (request: { readonly cwd: string; readonly npmPath: string }) => {
      state.npmRuns += 1;
      expect(request.npmPath).toBe("/fixture/npm");
      // npm ci receives the lockfile completed with first-party integrity hashes.
      const stagedLock = JSON.parse(
        await Bun.file(join(request.cwd, "package-lock.json")).text(),
      ) as {
        packages: Record<string, { integrity?: string }>;
      };
      expect(stagedLock.packages[`node_modules/${PI_PACKAGE_NAME}`]?.integrity).toBe(
        PI_TARBALL_INTEGRITY,
      );
      expect(request.cwd.startsWith(join(fixture.root, "deputydev", "pi-runtime"))).toBe(true);
      const packageDirectory = join(request.cwd, "node_modules", PI_PACKAGE_NAME);
      await mkdir(packageDirectory, { recursive: true });
      await Bun.write(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name: PI_PACKAGE_NAME, version }),
      );
      await mkdir(join(request.cwd, "node_modules", ".bin"), { recursive: true });
      await writePi(join(request.cwd, "node_modules", ".bin", "pi"), version);
    },
    warn: (message: string) => {
      state.warnings.push(message);
    },
  };
  return { dependencies, state };
}

const launchOptions = { userArguments: [], allowInstall: true } as const;

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Pi version policy", () => {
  test("pins an exact install version at or above the supported minimum", () => {
    expect(resolveConfiguredPiVersion({})).toBe(PI_INSTALL_VERSION);
    expect(Bun.semver.order(PI_INSTALL_VERSION, PI_MINIMUM_VERSION)).toBeGreaterThanOrEqual(0);
    expect(resolveConfiguredPiVersion({ DEPUTYDEV_PI_VERSION: "0.90.0" })).toBe("0.90.0");
    expect(() => resolveConfiguredPiVersion({ DEPUTYDEV_PI_VERSION: "latest" })).toThrow(
      "not a valid Pi version",
    );
    expect(() => resolveConfiguredPiVersion({ DEPUTYDEV_PI_VERSION: "1.2.3; rm -rf" })).toThrow(
      "not a valid Pi version",
    );
  });

  test("validates release artifacts the way Pi's managed installer does", () => {
    const good = releaseArtifacts("0.85.1");
    const completed = JSON.parse(validatePiReleaseArtifacts(good, "0.85.1")) as {
      packages: Record<string, { integrity?: string }>;
    };
    expect(completed.packages[`node_modules/${PI_PACKAGE_NAME}`]?.integrity).toBe(
      PI_TARBALL_INTEGRITY,
    );
    expect(completed.packages["node_modules/third-party"]?.integrity).toBe(
      "sha512-third-party-fixture",
    );
    expect(() => validatePiReleaseArtifacts(good, "0.85.0")).toThrow("must describe");

    const metadataMismatch = JSON.parse(good.metadata) as { version: string };
    metadataMismatch.version = "0.85.0";
    expect(() =>
      validatePiReleaseArtifacts({ ...good, metadata: JSON.stringify(metadataMismatch) }, "0.85.1"),
    ).toThrow("metadata must describe");

    const noMetadataIntegrity = JSON.parse(good.metadata) as {
      packages: { integrity?: string }[];
    };
    delete noMetadataIntegrity.packages[0]?.integrity;
    expect(() =>
      validatePiReleaseArtifacts(
        { ...good, metadata: JSON.stringify(noMetadataIntegrity) },
        "0.85.1",
      ),
    ).toThrow("lacks an integrity hash");

    const lockV2 = JSON.parse(good.packageLock) as { lockfileVersion: number };
    lockV2.lockfileVersion = 2;
    expect(() =>
      validatePiReleaseArtifacts({ ...good, packageLock: JSON.stringify(lockV2) }, "0.85.1"),
    ).toThrow("lockfileVersion 3");

    const noIntegrity = JSON.parse(good.packageLock) as {
      packages: Record<string, { integrity?: string }>;
    };
    delete noIntegrity.packages["node_modules/third-party"]?.integrity;
    expect(() =>
      validatePiReleaseArtifacts({ ...good, packageLock: JSON.stringify(noIntegrity) }, "0.85.1"),
    ).toThrow("lacks an integrity hash: node_modules/third-party");

    expect(() =>
      validatePiReleaseArtifacts({ ...good, packageJson: "not json" }, "0.85.1"),
    ).toThrow("not valid JSON");
  });
});

describe("Pi version probe cache", () => {
  test("probes once per executable identity and never caches unknown versions", async () => {
    const fixture = await createFixture("probe");
    const executable = join(fixture.bin, "pi");
    await writePi(executable, "0.85.1");
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return probes === 1 ? undefined : "0.85.1";
    };

    expect(await resolvePiVersion(executable, fixture.context, { probe })).toBeUndefined();
    expect(await resolvePiVersion(executable, fixture.context, { probe })).toBe("0.85.1");
    expect(await resolvePiVersion(executable, fixture.context, { probe })).toBe("0.85.1");
    expect(probes).toBe(2);
    expect(await Bun.file(fixture.context.paths.piExecutableState).exists()).toBe(true);

    // A changed executable invalidates the cached record.
    await Bun.sleep(5);
    await writePi(executable, "0.86.0 with a longer banner line\n");
    expect(await resolvePiVersion(executable, fixture.context)).toBe("0.86.0");
  });
});

describe("Pi executable resolution", () => {
  test("uses a compatible PATH pi without fetching anything", async () => {
    const fixture = await createFixture("compatible");
    const executable = join(fixture.bin, "pi");
    await writePi(executable, PI_MINIMUM_VERSION);
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);

    const resolved = await resolvePiExecutable(
      fixture.context,
      piRegistration(),
      launchOptions,
      dependencies,
    );

    expect(resolved).toBe(executable);
    expect(state.fetched).toEqual([]);
    expect(state.npmRuns).toBe(0);
  });

  test("installs the pinned release when PATH pi is too old and reuses it afterwards", async () => {
    const fixture = await createFixture("too-old");
    await writePi(join(fixture.bin, "pi"), "0.80.0");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);
    const registration = piRegistration();

    const resolved = await resolvePiExecutable(
      fixture.context,
      registration,
      launchOptions,
      dependencies,
    );

    expect(resolved).toBe(managedPiExecutable(fixture.context.paths, PI_INSTALL_VERSION));
    expect(state.fetched.sort()).toEqual([
      `${PI_RELEASES_API}/${PI_INSTALL_VERSION}`,
      `${PI_RELEASES_API}/${PI_INSTALL_VERSION}/package-lock.json`,
      `${PI_RELEASES_API}/${PI_INSTALL_VERSION}/package.json`,
    ]);
    expect(state.npmRuns).toBe(1);
    expect(state.warnings.join("\n")).toContain("older than the supported minimum");
    expect(await Bun.file(resolved).exists()).toBe(true);

    const again = await resolvePiExecutable(
      fixture.context,
      registration,
      launchOptions,
      dependencies,
    );
    expect(again).toBe(resolved);
    expect(state.fetched).toHaveLength(3);
    expect(state.npmRuns).toBe(1);
  });

  test("installs when pi is missing entirely and honors the configured version", async () => {
    const fixture = await createFixture("missing");
    Reflect.set(fixture.context.environment, "DEPUTYDEV_PI_VERSION", "0.90.0");
    const { dependencies, state } = installerDependencies(fixture, "0.90.0");

    const resolved = await resolvePiExecutable(
      fixture.context,
      piRegistration(),
      launchOptions,
      dependencies,
    );

    expect(resolved).toBe(managedPiExecutable(fixture.context.paths, "0.90.0"));
    expect(state.fetched).toHaveLength(3);
    for (const url of state.fetched) {
      expect(url).toContain(`${PI_RELEASES_API}/0.90.0`);
    }
  });

  test("keeps forwarded Pi administration on the user's pi even when it is old", async () => {
    const fixture = await createFixture("administrative");
    const executable = join(fixture.bin, "pi");
    await writePi(executable, "0.80.0");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);

    const resolved = await resolvePiExecutable(
      fixture.context,
      piRegistration(),
      { userArguments: ["update", "--extensions"], allowInstall: true },
      dependencies,
    );

    expect(resolved).toBe(executable);
    expect(state.npmRuns).toBe(0);
  });

  test("treats an explicit override as authoritative and only warns", async () => {
    const fixture = await createFixture("override");
    const executable = join(fixture.root, "custom pi");
    await writePi(executable, "0.80.0");
    Reflect.set(fixture.context.environment, "DEPUTYDEV_PI_BIN", executable);
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);

    const resolved = await resolvePiExecutable(
      fixture.context,
      piRegistration(),
      launchOptions,
      dependencies,
    );

    expect(resolved).toBe(executable);
    expect(state.npmRuns).toBe(0);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]).toContain("DEPUTYDEV_PI_BIN");
  });

  test("never installs for diagnostics or offline launches", async () => {
    const fixture = await createFixture("no-install");
    await writePi(join(fixture.bin, "pi"), "0.80.0");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);

    await expect(
      resolvePiExecutable(
        fixture.context,
        piRegistration(),
        { userArguments: [], allowInstall: false },
        dependencies,
      ),
    ).rejects.toMatchObject({ exitStatus: 121 });
    await expect(
      resolvePiExecutable(
        fixture.context,
        piRegistration(),
        { userArguments: ["--offline"], allowInstall: true },
        dependencies,
      ),
    ).rejects.toMatchObject({ exitStatus: 121 });
    expect(state.fetched).toEqual([]);
  });

  test("explains a missing or old Node.js toolchain without downloading", async () => {
    const fixture = await createFixture("toolchain");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);

    await expect(
      resolvePiExecutable(fixture.context, piRegistration(), launchOptions, {
        ...dependencies,
        probeToolchain: async () => ({ nodePath: "/fixture/node", nodeVersion: "20.0.0" }),
      }),
    ).rejects.toMatchObject({
      exitStatus: 125,
      message: expect.stringContaining("Node.js 20.0.0 is older than 22.19.0"),
      remediation: expect.stringContaining("https://pi.dev/install.sh"),
    });
    expect(state.fetched).toEqual([]);
  });

  test("fails clearly when the installed tree does not match the pinned version", async () => {
    const fixture = await createFixture("bad-tree");
    const { dependencies } = installerDependencies(fixture, PI_INSTALL_VERSION);

    await expect(
      resolvePiExecutable(fixture.context, piRegistration(), launchOptions, {
        ...dependencies,
        runNpmCi: async () => {},
      }),
    ).rejects.toMatchObject({
      exitStatus: 123,
      message: `failed to install Pi ${PI_INSTALL_VERSION}`,
    });
    expect(await Bun.file(fixture.context.paths.piRuntime).exists()).toBe(false);
  });
});
