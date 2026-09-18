import { join } from "node:path";

import {
  assertCanonicalSemVer,
  parseCliReleaseTag,
  readPackageVersion,
  requireEnvironmentVariable,
} from "./release-contract.ts";

interface ReleaseDetails {
  readonly name: string;
  readonly prerelease: boolean;
  readonly tag: string;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function getProperty(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function parseReleaseDetails(value: unknown): ReleaseDetails {
  const payload = asRecord(value, "GitHub event payload");
  const release =
    "release" in payload ? asRecord(getProperty(payload, "release"), "release") : payload;
  const tag = getProperty(release, "tag_name");
  const name = getProperty(release, "name");
  const prerelease = getProperty(release, "prerelease");

  if (typeof tag !== "string" || typeof name !== "string" || typeof prerelease !== "boolean") {
    throw new Error("release details must include string tag_name/name and boolean prerelease");
  }

  return { name, prerelease, tag };
}

async function readReleaseDetails(): Promise<ReleaseDetails> {
  const eventName = requireEnvironmentVariable("GITHUB_EVENT_NAME");
  const detailsPath =
    eventName === "release"
      ? requireEnvironmentVariable("GITHUB_EVENT_PATH")
      : requireEnvironmentVariable("RELEASE_DETAILS_FILE");
  const details: unknown = await Bun.file(detailsPath).json();
  return parseReleaseDetails(details);
}

export async function validateRelease(): Promise<void> {
  const expectedTag = requireEnvironmentVariable("RELEASE_TAG");
  const expectedVersion = requireEnvironmentVariable("RELEASE_VERSION");
  const details = await readReleaseDetails();
  const packageVersion = await readPackageVersion(join(process.cwd(), "package.json"));

  assertCanonicalSemVer(expectedVersion, "release version");
  const taggedVersion = parseCliReleaseTag(details.tag);

  if (details.tag !== expectedTag) {
    throw new Error(`release tag ${details.tag} does not equal requested tag ${expectedTag}`);
  }
  if (taggedVersion !== expectedVersion) {
    throw new Error(
      `release tag ${details.tag} carries version ${taggedVersion}, expected ${expectedVersion}`,
    );
  }
  if (details.name !== details.tag) {
    throw new Error(`release name ${details.name} must equal release tag ${details.tag}`);
  }
  if (packageVersion !== taggedVersion) {
    throw new Error(
      `package.json version ${packageVersion} must equal release tag version ${taggedVersion}`,
    );
  }
  if (!details.prerelease) {
    throw new Error(
      "the release must initially be published as a pre-release so assets can be verified before stable promotion",
    );
  }

  console.log(`Validated release contract for ${details.tag}.`);
}

if (import.meta.main) {
  try {
    await validateRelease();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
