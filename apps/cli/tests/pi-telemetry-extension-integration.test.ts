import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const piExecutable = join(repositoryRoot, "node_modules", ".bin", "pi");
const telemetryExtension = join(
  repositoryRoot,
  "src",
  "harnesses",
  "pi",
  "resources",
  "extensions",
  "pi-org-telemetry.mjs",
);
const temporaryDirectories: string[] = [];

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a TCP server address"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function runPi(
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const home = await mkdtemp(join(tmpdir(), "deputydev-pi-telemetry-e2e-"));
  temporaryDirectories.push(home);
  const subprocess = Bun.spawn(
    [
      piExecutable,
      "--offline",
      "--no-extensions",
      "--extension",
      telemetryExtension,
      "--list-models",
    ],
    {
      cwd: repositoryRoot,
      env: {
        HOME: home,
        PATH: Reflect.get(process.env, "PATH") ?? "",
        PI_CODING_AGENT_DIR: join(home, "pi"),
        PI_CODING_AGENT_SESSION_DIR: join(home, "pi", "sessions"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        ...extraEnvironment,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi telemetry extension integration", () => {
  test("loads in the managed Pi version without an OTLP endpoint", async () => {
    const result = await runPi();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test("does no OTLP network work when no endpoint is configured", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      response.writeHead(200).end();
    });
    const port = await listen(server);
    try {
      const result = await runPi({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(requests).toBe(0);
    } finally {
      await close(server);
    }
  });
});
