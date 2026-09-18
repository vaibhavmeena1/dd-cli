import { chmod, mkdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { HarnessLaunchContext } from "../../launcher/contracts.ts";
import { withFileLock } from "../../launcher/file-lock.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import type { DeputyDevPaths } from "../../product/paths.ts";

/**
 * OpenCode's reusable service is discovered exclusively through an XDG-state
 * registration file. DeputyDev gives its launches a separate XDG state root,
 * then starts the service on an ephemeral loopback port so it cannot collide
 * with the fixed port used by a normal OpenCode service.
 */

export interface ServiceRegistration {
  readonly url: string;
  readonly pid: number;
  readonly id?: string;
  readonly version?: string;
  readonly password?: string;
}

export interface ServiceFingerprint {
  readonly url: string;
  readonly pid: number;
  /** SHA-256 of the exact generated OPENCODE_CONFIG_CONTENT value. */
  readonly hash: string;
}

export interface ServiceReconcileResult {
  readonly action: "current" | "restarted" | "prewarmed";
  readonly registration: ServiceRegistration;
}

interface SpawnRequest {
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export type ServiceProcessSpawner = (request: SpawnRequest) => Promise<number>;

export interface DedicatedServiceStartRequest {
  readonly executable: string;
  readonly environment: NodeJS.ProcessEnv;
}

export type DedicatedServiceStarter = (
  request: DedicatedServiceStartRequest,
) => Promise<ServiceRegistration>;

const OPENCODE_STATE_DIRECTORY = "opencode";
const REGISTRATION_FILE_NAME = "service.json";
const SERVICE_START_TIMEOUT_MS = 15_000;
const SERVICE_START_POLL_MS = 50;
const SERVICE_HEALTH_TIMEOUT_MS = 1_000;

/** Resolve the OpenCode service registration path from its XDG state root. */
export function serviceRegistrationPath(environment: NodeJS.ProcessEnv): string {
  const userHome = environment["HOME"]?.trim() || homedir();
  const stateBase = environment["XDG_STATE_HOME"]?.trim() || join(userHome, ".local", "state");
  return join(stateBase, OPENCODE_STATE_DIRECTORY, REGISTRATION_FILE_NAME);
}

function parseRegistration(text: string): ServiceRegistration | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const { url, pid, id, version, password } = record;
  if (
    typeof url !== "string" ||
    url === "" ||
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return undefined;
  }
  return {
    url,
    pid,
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof version === "string" ? { version } : {}),
    ...(typeof password === "string" ? { password } : {}),
  };
}

export async function readServiceRegistration(
  environment: NodeJS.ProcessEnv,
): Promise<ServiceRegistration | undefined> {
  const text = await readFile(serviceRegistrationPath(environment), "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseRegistration(text);
}

/** Confirm that a registration points to its authenticated V2 health endpoint. */
export async function probeServiceRegistration(
  registration: ServiceRegistration,
): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/health", registration.url), {
      headers:
        registration.password === undefined
          ? undefined
          : {
              authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}`,
            },
      signal: AbortSignal.timeout(SERVICE_HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null) {
      return false;
    }
    const health = body as Record<string, unknown>;
    if (health["pid"] !== registration.pid) {
      return false;
    }
    return (
      registration.version === undefined ||
      health["version"] === undefined ||
      health["version"] === registration.version
    );
  } catch {
    return false;
  }
}

function parseFingerprint(text: string): ServiceFingerprint | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const { url, pid, hash } = record;
  if (
    typeof url !== "string" ||
    url === "" ||
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof hash !== "string" ||
    hash === ""
  ) {
    return undefined;
  }
  return { url, pid, hash };
}

async function readFingerprint(path: string): Promise<ServiceFingerprint | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseFingerprint(text);
}

async function writeFingerprint(path: string, fingerprint: ServiceFingerprint): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(fingerprint, null, 2)}\n`);
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Run a short OpenCode service-management command without polluting child stdout. */
export const spawnServiceCommand: ServiceProcessSpawner = async (request) => {
  const executable = request.arguments[0];
  if (executable === undefined) {
    throw new Error("missing OpenCode executable for service command");
  }
  const subprocess = Bun.spawn([executable, ...request.arguments.slice(1)], {
    env: request.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, _stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0 && stderr.trim() !== "") {
    console.error(stderr.trimEnd());
  }
  return exitCode;
};

interface DedicatedServiceDependencies {
  readonly readRegistration?: typeof readServiceRegistration;
  readonly probeRegistration?: typeof probeServiceRegistration;
}

/**
 * Start OpenCode's service process directly on an ephemeral loopback port.
 * The resulting registration routes later DeputyDev clients to this process;
 * no normal OpenCode registration or fixed service port is touched.
 */
export async function startDedicatedOpenCodeService(
  request: DedicatedServiceStartRequest,
  dependencies: DedicatedServiceDependencies = {},
): Promise<ServiceRegistration> {
  const readRegistration = dependencies.readRegistration ?? readServiceRegistration;
  const probeRegistration = dependencies.probeRegistration ?? probeServiceRegistration;
  const subprocess = Bun.spawn(
    [request.executable, "serve", "--service", "--hostname", "127.0.0.1", "--port", "0"],
    {
      env: request.environment,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  subprocess.unref();

  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (subprocess.exitCode !== null) {
      throw new Error(`dedicated OpenCode service exited with code ${subprocess.exitCode}`);
    }
    const registration = await readRegistration(request.environment);
    if (
      registration !== undefined &&
      registration.pid === subprocess.pid &&
      (await probeRegistration(registration))
    ) {
      return registration;
    }
    await Bun.sleep(SERVICE_START_POLL_MS);
  }

  subprocess.kill("SIGTERM");
  throw new Error("timed out waiting for the dedicated OpenCode service to start");
}

export interface ReconcileOpenCodeServiceOptions {
  readonly context: HarnessLaunchContext;
  readonly paths: DeputyDevPaths;
  /** Final child environment, including isolated XDG state and inline config. */
  readonly environment: NodeJS.ProcessEnv;
  /** Hash of the exact inline config in `environment`. */
  readonly configHash: string;
  readonly run?: ServiceProcessSpawner;
  readonly start?: DedicatedServiceStarter;
  readonly readRegistration?: typeof readServiceRegistration;
  readonly probeRegistration?: typeof probeServiceRegistration;
}

/**
 * Ensure the dedicated service is healthy and running with this launch's exact
 * generated config. Any inability to establish that invariant fails clearly;
 * DeputyDev never silently launches a session without required extensions.
 */
export async function reconcileOpenCodeService(
  options: ReconcileOpenCodeServiceOptions,
): Promise<ServiceReconcileResult> {
  const { context, paths, environment, configHash } = options;
  const run = options.run ?? spawnServiceCommand;
  const readRegistration = options.readRegistration ?? readServiceRegistration;
  const probeRegistration = options.probeRegistration ?? probeServiceRegistration;
  const start =
    options.start ??
    ((request: DedicatedServiceStartRequest) =>
      startDedicatedOpenCodeService(request, { readRegistration, probeRegistration }));

  return withFileLock(paths.opencodeServiceLock, async () => {
    const registration = await readRegistration(environment);
    const healthy = registration !== undefined && (await probeRegistration(registration));
    const fingerprint = await readFingerprint(paths.opencodeServiceState);

    if (
      healthy &&
      registration !== undefined &&
      fingerprint !== undefined &&
      fingerprint.pid === registration.pid &&
      fingerprint.url === registration.url &&
      fingerprint.hash === configHash
    ) {
      return { action: "current", registration };
    }

    if (healthy && registration !== undefined) {
      console.error(
        `${PRODUCT_IDENTITY.command}: restarting the dedicated OpenCode service to enable DeputyDev extensions...`,
      );
      const exitCode = await run({
        arguments: [context.executable, "service", "stop"],
        environment,
      });
      if (exitCode !== 0) {
        throw new Error(`could not stop the dedicated OpenCode service (exit ${exitCode})`);
      }
    }

    const started = await start({ executable: context.executable, environment });
    if (!(await probeRegistration(started))) {
      throw new Error(
        "the dedicated OpenCode service did not pass its health check after starting",
      );
    }
    await writeFingerprint(paths.opencodeServiceState, {
      url: started.url,
      pid: started.pid,
      hash: configHash,
    });
    return {
      action: registration === undefined ? "prewarmed" : "restarted",
      registration: started,
    };
  });
}
