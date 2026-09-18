import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseRepoSlug, resolveRepoSlug } from "../src/repo.ts";

test("normalizes scp-style ssh remotes", () => {
  assert.equal(parseRepoSlug("git@github.com:Acme/Backend.git\n"), "github.com/Acme/Backend");
  assert.equal(parseRepoSlug("github.com:acme/backend"), "github.com/acme/backend");
});

test("normalizes ssh URLs with ports and users", () => {
  assert.equal(
    parseRepoSlug("ssh://git@gitlab.example.com:2222/platform/api.git"),
    "gitlab.example.com/platform/api",
  );
});

test("strips embedded credentials from https remotes", () => {
  const slug = parseRepoSlug("https://alice:ghp_secret123@GitHub.com/acme/backend.git");
  assert.equal(slug, "github.com/acme/backend");
  assert.doesNotMatch(String(slug), /alice|secret/);
});

test("keeps gitlab subgroups and drops azure _git segments", () => {
  assert.equal(
    parseRepoSlug("https://gitlab.com/group/subgroup/project.git"),
    "gitlab.com/group/subgroup/project",
  );
  assert.equal(
    parseRepoSlug("https://dev.azure.com/org/project/_git/repo"),
    "dev.azure.com/org/project/repo",
  );
});

test("ignores local paths, file URLs, and malformed remotes", () => {
  for (const remote of [
    "/Users/alice/repos/backend",
    "./backend",
    "../backend",
    "~/backend",
    "C:\\repos\\backend",
    "file:///Users/alice/repos/backend.git",
    "https://github.com/only-one-segment",
    "git@github.com:acme/bad segment",
    "",
    undefined,
  ]) {
    assert.equal(parseRepoSlug(remote), undefined, `expected undefined for ${String(remote)}`);
  }
});

test("omits the slug when origin is missing or git fails", async () => {
  assert.equal(
    await resolveRepoSlug({ cwd: "/work", readRemoteUrl: async () => undefined }),
    undefined,
  );
  assert.equal(
    await resolveRepoSlug({
      cwd: "/work",
      readRemoteUrl: async () => {
        throw new Error("no git");
      },
    }),
    undefined,
  );
  assert.equal(
    await resolveRepoSlug({
      cwd: "/work",
      readRemoteUrl: async () => "git@github.com:acme/backend.git",
    }),
    "github.com/acme/backend",
  );
});
