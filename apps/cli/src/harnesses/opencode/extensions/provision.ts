import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { BUILD_INFO } from "../../../build-info.ts";
import { withFileLock } from "../../../launcher/file-lock.ts";
import type { DeputyDevPaths } from "../../../product/paths.ts";
import type { OpenCodeExtensionProvisionResult, OpenCodeProvisionOptions } from "./contracts.ts";

interface PreparedResource {
  readonly bytes: Uint8Array;
  readonly plugin: string;
  readonly destination: string;
  readonly hash: string;
  readonly id: string;
}

function hashBytes(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

function validateResource(resource: OpenCodeProvisionOptions["resources"][number]): void {
  const parts = resource.destination.split(/[\\/]/);
  if (
    resource.destination.startsWith("/") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe embedded OpenCode resource destination: ${resource.destination}`);
  }
}

function hashExtensionSet(
  resources: readonly PreparedResource[],
  specifiers: readonly string[],
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const resource of resources) {
    hasher.update(
      `${resource.id}\0${resource.plugin}\0${resource.destination}\0${resource.hash}\0`,
    );
  }
  hasher.update(`packages\0${specifiers.join("\0")}\0`);
  return hasher.digest("hex");
}

async function prepareResources(
  resources: OpenCodeProvisionOptions["resources"],
): Promise<readonly PreparedResource[]> {
  const prepared: PreparedResource[] = [];
  for (const resource of resources) {
    validateResource(resource);
    const bytes = new Uint8Array(await Bun.file(resource.sourcePath).arrayBuffer());
    prepared.push({
      bytes,
      destination: resource.destination,
      hash: hashBytes(bytes),
      id: resource.id,
      plugin: resource.plugin,
    });
  }
  return prepared;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    return status.isFile() && !status.isSymbolicLink();
  } catch {
    return false;
  }
}

async function hasSafeResourceParents(
  runtimeDirectory: string,
  destination: string,
): Promise<boolean> {
  const parts = relative(runtimeDirectory, dirname(destination)).split(/[\\/]/).filter(Boolean);
  let current = runtimeDirectory;
  for (const part of ["", ...parts]) {
    current = part === "" ? current : join(current, part);
    try {
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function verifyRuntime(
  runtimeDirectory: string,
  resources: readonly PreparedResource[],
  hash: string,
): Promise<boolean> {
  for (const resource of resources) {
    const destination = join(runtimeDirectory, resource.plugin, resource.destination);
    if (!(await hasSafeResourceParents(runtimeDirectory, destination))) {
      return false;
    }
    if (!(await isRegularFile(destination))) {
      return false;
    }
    const bytes = new Uint8Array(await Bun.file(destination).arrayBuffer());
    if (hashBytes(bytes) !== resource.hash) {
      return false;
    }
  }
  const manifest = join(runtimeDirectory, "manifest.json");
  if (!(await isRegularFile(manifest))) {
    return false;
  }
  const recorded = (await Bun.file(manifest)
    .json()
    .catch(() => undefined)) as { hash?: unknown } | undefined;
  return recorded?.hash === hash;
}

async function materializeRuntime(
  paths: DeputyDevPaths,
  runtimeDirectory: string,
  resources: readonly PreparedResource[],
  hash: string,
): Promise<void> {
  const temporaryDirectory = join(
    paths.runtime,
    `.materialize-opencode-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    for (const resource of resources) {
      const destination = join(temporaryDirectory, resource.plugin, resource.destination);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await Bun.write(destination, resource.bytes);
      await chmod(destination, 0o644);
    }
    await Bun.write(
      join(temporaryDirectory, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "opencode-extensions",
          hash,
          resources: resources.map(({ bytes: _bytes, ...resource }) => resource),
        },
        null,
        2,
      )}\n`,
    );

    if (!(await verifyRuntime(temporaryDirectory, resources, hash))) {
      throw new Error("embedded OpenCode resource verification failed before activation");
    }

    await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
    try {
      await rename(temporaryDirectory, runtimeDirectory);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function pluginDirectory(
  runtimeDirectory: string,
  resources: readonly PreparedResource[],
): string[] {
  return [...new Set(resources.map((resource) => join(runtimeDirectory, resource.plugin)))];
}

/**
 * Materialize bundled OpenCode plugins into one immutable, content-keyed
 * runtime directory and derive the enabled extension entries.
 *
 * The directory name pins the DeputyDev build version and the extension-set
 * hash, so a concurrent launcher of another version can never collide with or
 * mutate an in-use runtime.
 */
export async function provisionOpenCodeExtensions(
  paths: DeputyDevPaths,
  options: OpenCodeProvisionOptions,
): Promise<OpenCodeExtensionProvisionResult> {
  const prepared = await prepareResources(options.resources);
  const specifiers = options.publicPlugins.map((plugin) => plugin.specifier);
  const hash = hashExtensionSet(prepared, specifiers);
  const runtimeDirectory = join(
    paths.runtime,
    `opencode-${BUILD_INFO.version}-${hash.slice(0, 16)}`,
  );

  const result: OpenCodeExtensionProvisionResult = {
    runtimeDirectory,
    pluginDirectories: pluginDirectory(runtimeDirectory, prepared),
    pluginSpecifiers: specifiers,
    hash,
  };

  if (await verifyRuntime(runtimeDirectory, prepared, hash)) {
    return result;
  }

  await withFileLock(paths.materializationLock, async () => {
    // Another launcher may have materialized the same set while we waited.
    if (await verifyRuntime(runtimeDirectory, prepared, hash)) {
      return;
    }
    await materializeRuntime(paths, runtimeDirectory, prepared, hash);
    if (!(await verifyRuntime(runtimeDirectory, prepared, hash))) {
      throw new Error("embedded OpenCode resource verification failed after activation");
    }
  });

  return result;
}
