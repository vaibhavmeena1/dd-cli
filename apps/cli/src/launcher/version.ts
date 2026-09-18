const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const NON_NUMERIC_IDENTIFIER = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`;
const BUILD_IDENTIFIER = "(?:[0-9A-Za-z-]+)";
const SEMVER_SOURCE =
  `${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}` +
  `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?` +
  `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?`;

/** Strict semantic version: no `v` prefix, no ranges, no shell metacharacters. */
export const SEMVER_PATTERN = new RegExp(`^${SEMVER_SOURCE}$`);

export function isSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

/** Negative when `left` is older than `right`, zero when equal, positive when newer. */
export function compareSemVer(left: string, right: string): number {
  return Bun.semver.order(left, right);
}

/**
 * Extract the first semantic version from command output such as `0.85.1` or
 * `v26.8.2`. Only the first line is considered so banners cannot spoof it.
 */
export function parseFirstSemVer(output: string): string | undefined {
  const firstLine = output.trim().split(/\r?\n/, 1)[0] ?? "";
  const match = firstLine.match(new RegExp(`v?(${SEMVER_SOURCE})`));
  return match?.[1];
}
