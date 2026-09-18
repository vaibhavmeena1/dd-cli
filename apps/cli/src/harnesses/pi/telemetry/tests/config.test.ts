import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseResourceAttributes, resolveConfig } from "../src/config.ts";

test("disables silently without a managed endpoint", () => {
  assert.equal(resolveConfig({}), undefined);
  assert.equal(
    resolveConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      PI_ORG_OTEL_ENABLED: "false",
    }),
    undefined,
  );
});

test("does not send unconfigured signals to implicit localhost defaults", () => {
  assert.equal(
    resolveConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector/v1/traces" }),
    undefined,
  );
});

test("resolves managed OTLP settings with bounded values", () => {
  const config = resolveConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector",
    OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    OTEL_SERVICE_NAME: "org-pi",
    OTEL_METRIC_EXPORT_INTERVAL: "50",
    OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
    OTEL_TRACES_SAMPLER_ARG: "0.25",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod,team=developer%20experience",
  });

  assert.ok(config);
  assert.equal(config.protocol, "grpc");
  assert.equal(config.serviceName, "org-pi");
  assert.equal(config.metricExportIntervalMs, 1_000);
  assert.equal(config.sampleRatio, 0.25);
  assert.deepEqual(config.resourceAttributes, {
    "deployment.environment": "prod",
    team: "developer experience",
  });
});

test("resource attributes tolerate malformed encoding", () => {
  assert.deepEqual(parseResourceAttributes("team=dev%ZZ,broken,no-name"), { team: "dev%ZZ" });
});

test("honors bounded OTEL_BSP and OTEL_BLRP batch settings", () => {
  const config = resolveConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector",
    OTEL_BSP_SCHEDULE_DELAY: "5000",
    OTEL_BSP_MAX_QUEUE_SIZE: "999999",
    OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: "abc",
    OTEL_BSP_EXPORT_TIMEOUT: "10",
  });
  assert.ok(config);
  assert.equal(config.scheduledDelayMs, 5_000);
  assert.equal(config.maxQueueSize, 16_384);
  assert.equal(config.maxExportBatchSize, 256);
  assert.equal(config.exportTimeoutMs, 500);
  const defaults = resolveConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector" });
  assert.deepEqual(
    [
      defaults?.maxQueueSize,
      defaults?.maxExportBatchSize,
      defaults?.scheduledDelayMs,
      defaults?.exportTimeoutMs,
    ],
    [2_048, 256, 1_000, 3_000],
  );
});
