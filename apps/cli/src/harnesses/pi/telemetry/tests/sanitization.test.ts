import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  sanitizePath,
  sanitizeText,
  summarizeShellCommand,
  summarizeToolInput,
  summarizeToolOutput,
} from "../src/sanitization.ts";

const cwd = "/Users/alice/work/project";

test("sanitizes credentials, project paths, home paths, and long text", () => {
  const sanitized = sanitizeText(
    "curl -H 'Authorization: Bearer secret-token' https://me:password@example.com /Users/alice/work/project/src/index.ts --api-key abc123",
    cwd,
    undefined,
    "/Users/alice",
  );
  assert.doesNotMatch(sanitized, /secret-token|password|abc123|\/Users\/alice/);
  assert.match(sanitized, /Authorization:<redacted> <redacted>/);
  assert.match(sanitized, /<project>/);
  assert.ok(sanitized.length <= 257);
  assert.equal(
    sanitizeText("see /Users/alice/notes.txt", "/tmp/elsewhere", undefined, "/Users/alice"),
    "see <home>/notes.txt",
  );
});

test("measures tool output without reading image data", () => {
  const summary = summarizeToolOutput({
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "A".repeat(50_000), mimeType: "image/png" },
      { type: "text", text: " world" },
    ],
    details: { huge: "B".repeat(10_000) },
  });
  assert.deepEqual(summary, { textLength: 11, imageCount: 1, partCount: 3 });
  assert.deepEqual(summarizeToolOutput(null), { textLength: 0, imageCount: 0, partCount: 0 });
  assert.deepEqual(summarizeToolOutput({ content: null }), {
    textLength: 0,
    imageCount: 0,
    partCount: 0,
  });
  assert.deepEqual(summarizeToolOutput("plain string"), {
    textLength: 0,
    imageCount: 0,
    partCount: 0,
  });
});

test("keeps project paths relative and hides external path prefixes", () => {
  assert.equal(sanitizePath("src/index.ts", cwd), "src/index.ts");
  assert.equal(sanitizePath("/Users/alice/.ssh/id_rsa", cwd), "<external>/id_rsa");
});

test("uses fixed summaries for built-in and unknown tools", () => {
  assert.deepEqual(summarizeToolInput("read", { path: `${cwd}/README.md` }, cwd), {
    "pi.tool.input_size": 46,
    "pi.path": "README.md",
  });
  const unknown = summarizeToolInput("custom", { query: "private", limit: 5 }, cwd);
  assert.deepEqual(unknown["pi.tool.input_keys"], ["limit", "query"]);
  assert.equal(unknown.query, undefined);

  const command = summarizeShellCommand("API_KEY=secret npm test", cwd);
  assert.equal(command["pi.command.executable"], "npm");
  assert.doesNotMatch(String(command["pi.command.summary"]), /secret/);
});
