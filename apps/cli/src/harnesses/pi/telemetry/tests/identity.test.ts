import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIdentity } from "../src/identity.ts";

test("uses raw Git email as the primary identity", async () => {
  const identity = await resolveIdentity({ readGitEmail: () => " engineer@example.com " });
  assert.deepEqual(identity, {
    userId: "engineer@example.com",
    email: "engineer@example.com",
    source: "git_email",
  });
});

test("creates and reuses a protected installation UUID fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-org-telemetry-"));
  const options = {
    env: { PI_CODING_AGENT_DIR: root },
    homeDir: root,
    readGitEmail: () => undefined,
  } as const;

  const first = await resolveIdentity(options);
  const second = await resolveIdentity(options);
  const identityPath = join(root, "pi-org-telemetry", "identity.json");
  const stored = JSON.parse(await readFile(identityPath, "utf8")) as { installationId: string };
  const mode = (await stat(identityPath)).mode & 0o777;

  assert.equal(first.source, "installation_id");
  assert.equal(first.userId, second.userId);
  assert.equal(first.userId, stored.installationId);
  assert.match(first.userId, /^[0-9a-f-]{36}$/);
  assert.equal(mode, 0o600);
});

test("repairs a malformed fallback identity without user intervention", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-org-telemetry-corrupt-"));
  const directory = join(root, "pi-org-telemetry");
  await mkdir(directory);
  await writeFile(join(directory, "identity.json"), "not-json", { mode: 0o600 });

  const identity = await resolveIdentity({
    env: { PI_CODING_AGENT_DIR: root },
    homeDir: root,
    readGitEmail: () => undefined,
  });

  assert.equal(identity.source, "installation_id");
  assert.match(identity.userId, /^[0-9a-f-]{36}$/);
  const stored = JSON.parse(await readFile(join(directory, "identity.json"), "utf8")) as {
    installationId: string;
  };
  assert.equal(stored.installationId, identity.userId);
});

test("accepts an async git email reader", async () => {
  const identity = await resolveIdentity({ readGitEmail: async () => "async@example.com" });
  assert.equal(identity.userId, "async@example.com");
  assert.equal(identity.source, "git_email");
});
