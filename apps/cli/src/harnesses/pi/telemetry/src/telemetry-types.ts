import type { Attributes, Context, Tracer } from "@opentelemetry/api";

export type LogSeverity = "debug" | "info" | "warn" | "error";

export interface MetricSink {
  count(name: string, value?: number, attributes?: Attributes, unit?: string): void;
  record(name: string, value: number, unit: string, attributes?: Attributes): void;
}

export interface LogSink {
  emit(
    severity: LogSeverity,
    eventName: string,
    body: string,
    attributes?: Attributes,
    context?: Context,
  ): void;
}

export interface TelemetryRuntime {
  readonly tracer: Tracer;
  readonly metrics: MetricSink;
  readonly logs: LogSink;
  readonly commonAttributes: Attributes;
  shutdown(): Promise<void>;
}
