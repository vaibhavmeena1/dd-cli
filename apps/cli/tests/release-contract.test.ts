import { describe, expect, test } from "bun:test";

import {
  formatCliReleaseTag,
  isCanonicalSemVer,
  isCliReleaseTag,
  parseCliReleaseTag,
} from "../scripts/release-contract.ts";
import { PRODUCT_IDENTITY } from "../src/product/identity.ts";
import { resolveDeputyDevPaths } from "../src/product/paths.ts";
import { parseServiceOrigin } from "../src/product/service-origin.ts";

describe("release version contract", () => {
  test("accepts canonical stable and prerelease versions", () => {
    expect(isCanonicalSemVer("0.1.0")).toBe(true);
    expect(isCanonicalSemVer("0.1.0-rc.1")).toBe(true);
    expect(isCanonicalSemVer("1.2.3-alpha.1+build.5")).toBe(true);
  });

  test("rejects prefixes and non-canonical numeric identifiers", () => {
    expect(isCanonicalSemVer("v0.1.0")).toBe(false);
    expect(isCanonicalSemVer("01.1.0")).toBe(false);
    expect(isCanonicalSemVer("1.0.0-01")).toBe(false);
    expect(isCanonicalSemVer("1.0")).toBe(false);
  });
});

describe("CLI release tag contract", () => {
  test("namespaces CLI tags so other monorepo components cannot collide", () => {
    expect(formatCliReleaseTag("0.2.0")).toBe("cli-0.2.0");
    expect(parseCliReleaseTag("cli-0.2.0")).toBe("0.2.0");
    expect(parseCliReleaseTag("cli-0.2.0-rc.1")).toBe("0.2.0-rc.1");
    expect(isCliReleaseTag("cli-0.2.0")).toBe(true);
  });

  test("rejects bare, v-prefixed, and foreign component tags", () => {
    expect(isCliReleaseTag("0.2.0")).toBe(false);
    expect(isCliReleaseTag("cli-v0.2.0")).toBe(false);
    expect(isCliReleaseTag("backend-0.2.0")).toBe(false);
    expect(() => parseCliReleaseTag("backend-0.2.0")).toThrow(/must start with cli-/);
    expect(() => parseCliReleaseTag("cli-01.0.0")).toThrow(/canonical semantic version/);
    expect(() => formatCliReleaseTag("v0.2.0")).toThrow(/canonical semantic version/);
  });
});

describe("production service origin contract", () => {
  test("accepts an HTTPS origin only", () => {
    expect(parseServiceOrigin("https://cli.example.test:8443", { allowLoopbackHttp: false })).toBe(
      "https://cli.example.test:8443",
    );
  });

  test("rejects HTTP and URL components beyond the origin", () => {
    expect(() =>
      parseServiceOrigin("http://cli.example.test", { allowLoopbackHttp: false }),
    ).toThrow("must use HTTPS");
    expect(() =>
      parseServiceOrigin("https://cli.example.test/path", { allowLoopbackHttp: false }),
    ).toThrow("only scheme, host, and optional port");
    expect(() =>
      parseServiceOrigin("https://cli.example.test/", { allowLoopbackHttp: false }),
    ).toThrow("must not have a trailing slash");
  });
});

describe("ddcli command identity", () => {
  test("uses ddcli while retaining the existing DeputyDev home", () => {
    const paths = resolveDeputyDevPaths({}, "/Users/example");

    expect(PRODUCT_IDENTITY.command).toBe("ddcli");
    expect(paths.home).toBe("/Users/example/.deputydev");
    expect(paths.managedBinary).toBe("/Users/example/.deputydev/bin/ddcli");
    expect(paths.previousBinary).toBe("/Users/example/.deputydev/bin/ddcli.prev");
  });
});
