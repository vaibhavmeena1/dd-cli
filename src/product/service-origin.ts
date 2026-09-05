const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface ServiceOriginOptions {
  readonly allowLoopbackHttp: boolean;
}

export function parseServiceOrigin(value: string, options: ServiceOriginOptions): string {
  if (value.endsWith("/")) {
    throw new Error("service origin must not have a trailing slash");
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("service origin must be an absolute URL");
  }

  const hasOriginOnlyPath = url.pathname === "/";
  const hasQueryOrFragmentDelimiter = value.includes("?") || value.includes("#");
  const hasDisallowedComponents =
    !hasOriginOnlyPath || hasQueryOrFragmentDelimiter || url.username !== "" || url.password !== "";

  if (hasDisallowedComponents) {
    throw new Error("service origin must contain only scheme, host, and optional port");
  }

  const isHttps = url.protocol === "https:";
  const isAllowedLoopbackHttp =
    options.allowLoopbackHttp && url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);

  if (!isHttps && !isAllowedLoopbackHttp) {
    throw new Error("service origin must use HTTPS outside loopback development");
  }

  return url.origin;
}
