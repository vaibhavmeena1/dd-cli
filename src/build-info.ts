import { parseServiceOrigin } from "./product/service-origin.ts";

export type BuildKind = "binary" | "managed" | "dev";

declare const BUILD_VERSION: string;
declare const BUILD_KIND: BuildKind;
declare const BUILD_TARGET: string;
declare const BUILD_COMMIT: string;
declare const BUILD_SERVICE_ORIGIN: string;

const SERVICE_ORIGIN_ENVIRONMENT_VARIABLE = "DEPUTYDEV_SERVICE_ORIGIN";
const buildKind: BuildKind = typeof BUILD_KIND === "undefined" ? "dev" : BUILD_KIND;
const configuredServiceOrigin =
  typeof BUILD_SERVICE_ORIGIN === "undefined"
    ? (process.env[SERVICE_ORIGIN_ENVIRONMENT_VARIABLE] ?? "http://localhost:3000")
    : BUILD_SERVICE_ORIGIN;

export const BUILD_INFO = Object.freeze({
  version: typeof BUILD_VERSION === "undefined" ? "0.0.0-dev" : BUILD_VERSION,
  kind: buildKind,
  target:
    typeof BUILD_TARGET === "undefined" ? `${process.platform}-${process.arch}` : BUILD_TARGET,
  commit: typeof BUILD_COMMIT === "undefined" ? "local" : BUILD_COMMIT,
  serviceOrigin: parseServiceOrigin(configuredServiceOrigin, {
    allowLoopbackHttp: buildKind === "dev",
  }),
});

export type BuildInfo = typeof BUILD_INFO;
