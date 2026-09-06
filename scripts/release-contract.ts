const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const NON_NUMERIC_IDENTIFIER = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`;
const BUILD_IDENTIFIER = "(?:[0-9A-Za-z-]+)";

const CANONICAL_SEMVER = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}` +
    `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?` +
    `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`,
);

export function isCanonicalSemVer(value: string): boolean {
  return CANONICAL_SEMVER.test(value);
}

export function assertCanonicalSemVer(value: string, label: string): void {
  if (!isCanonicalSemVer(value)) {
    throw new Error(`${label} must be a canonical semantic version without a v prefix: ${value}`);
  }
}

export function optionalEnvironmentVariable(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

export function requireEnvironmentVariable(name: string): string {
  const value = optionalEnvironmentVariable(name);
  if (value === undefined) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export async function readPackageVersion(packageJsonPath: string): Promise<string> {
  const contents: unknown = await Bun.file(packageJsonPath).json();
  if (typeof contents !== "object" || contents === null || !("version" in contents)) {
    throw new Error(`${packageJsonPath} does not contain a version`);
  }

  const version = contents.version;
  if (typeof version !== "string") {
    throw new Error(`${packageJsonPath} version must be a string`);
  }

  assertCanonicalSemVer(version, "package.json version");
  return version;
}

export function assertReleaseCommit(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`BUILD_COMMIT must be a full lowercase Git commit SHA: ${value}`);
  }
}

export function assertGitHubRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`GITHUB_REPOSITORY must have the owner/repository form: ${value}`);
  }
}
