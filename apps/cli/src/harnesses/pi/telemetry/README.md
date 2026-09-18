# Embedded Pi organization telemetry

This directory vendors and adapts `pi-org-telemetry` version `0.2.0` for DeputyDev.
The imported source was provided from:

```text
/Users/vaibhavmeena/Desktop/1mg/pi-otel-telemetry/pi-org-telemetry
```

The source repository had no commits when imported, so the files in this directory are the
reviewable source of truth for the imported snapshot. `UPSTREAM_SNAPSHOT.sha256` records every
imported source/test/doc/dashboard hash, and `UPSTREAM_PACKAGE.json` preserves the original package
metadata. DeputyDev changes include:

- Bun tests and DeputyDev TypeScript/Biome compatibility;
- a compile-time extension version because the materialized bundle has no adjacent package.json;
- deterministic bundling of OpenTelemetry dependencies into one standalone ESM extension;
- embedding and checksum-protected materialization through DeputyDev's Pi resource manifest.

## Build

```bash
bun run telemetry:build
bun run telemetry:check
bun test src/harnesses/pi/telemetry/tests
```

`telemetry:build` writes
`src/harnesses/pi/resources/extensions/pi-org-telemetry.mjs`. Pi supplies only
`@earendil-works/pi-coding-agent`; all OpenTelemetry runtime dependencies are inside that generated
file. Loading it with `--extension` does not install packages or contact a registry.

## Runtime

The extension is loaded for every non-administrative `ddcli pi` invocation. It stays inert when a
managed OTLP endpoint is absent. Configure `OTEL_EXPORTER_OTLP_ENDPOINT`, or all three per-signal
endpoints, in the environment used to start `ddcli`.

Read these documents before changing exported data:

- [Data policy](docs/data-policy.md)
- [Telemetry schema](docs/telemetry-schema.md)
- [Deployment](docs/deployment.md)
- [Limitations](docs/limitations.md)

The upstream extension is MIT licensed. Bundled OpenTelemetry dependencies are Apache-2.0; both
license texts are retained in the generated bundle's legal banner.
