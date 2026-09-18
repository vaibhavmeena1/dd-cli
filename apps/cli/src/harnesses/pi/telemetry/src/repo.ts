import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepoSlugOptions {
  readonly cwd: string;
  readonly readRemoteUrl?: (cwd: string) => Promise<string | undefined>;
}

const MAX_SLUG_LENGTH = 200;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_REMOTE = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/;
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|[/~]|\.\.?[\\/])/;
function isUnsafeSegment(segment: string): boolean {
  return [...segment].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /\s/.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
  });
}

async function defaultReadRemoteUrl(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizePath(path: string): string[] | undefined {
  const trimmed = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  const segments = trimmed
    .split("/")
    .map((segment) => decodeSegment(segment).trim())
    .filter((segment) => segment !== "" && segment !== "_git");
  if (segments.length < 2) return undefined;
  if (segments.some((segment) => segment === "." || segment === ".." || isUnsafeSegment(segment))) {
    return undefined;
  }
  return segments;
}

/**
 * Normalize a Git remote into `host/org/repo`. Credentials, ports, schemes, and `.git` suffixes are
 * removed; local paths, `file:` URLs, and unparsable values yield undefined. The raw remote URL is
 * never returned.
 */
export function parseRepoSlug(remote: string | undefined): string | undefined {
  const value = remote?.trim();
  if (!value || LOCAL_PATH.test(value)) return undefined;

  let host: string | undefined;
  let path: string | undefined;
  if (URL_SCHEME.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === "file:" || !url.hostname) return undefined;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    const match = SCP_REMOTE.exec(value);
    if (!match) return undefined;
    host = match[1];
    path = match[2];
  }
  if (!host || !path) return undefined;

  const segments = normalizePath(path);
  if (!segments) return undefined;
  const slug = `${host.toLowerCase()}/${segments.join("/")}`;
  return slug.length <= MAX_SLUG_LENGTH ? slug : undefined;
}

export async function resolveRepoSlug(options: RepoSlugOptions): Promise<string | undefined> {
  const read = options.readRemoteUrl ?? defaultReadRemoteUrl;
  try {
    return parseRepoSlug(await read(options.cwd));
  } catch {
    return undefined;
  }
}
