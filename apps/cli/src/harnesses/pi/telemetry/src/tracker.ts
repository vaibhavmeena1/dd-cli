import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_CACHE_READ_TOKENS,
  ATTR_CACHE_WRITE_TOKENS,
  ATTR_CONTEXT_PERCENT,
  ATTR_CONTEXT_TOKENS,
  ATTR_CONTEXT_WINDOW,
  ATTR_CONVERSATION_ID,
  ATTR_COST,
  ATTR_COST_CACHE_READ,
  ATTR_COST_CACHE_WRITE,
  ATTR_COST_INPUT,
  ATTR_COST_OUTPUT,
  ATTR_ERROR_TYPE,
  ATTR_INPUT_TOKENS,
  ATTR_LLM_TRUNCATED,
  ATTR_MODE,
  ATTR_OPERATION,
  ATTR_OUTPUT_TOKENS,
  ATTR_PARENT_SESSION_ID,
  ATTR_PROJECT,
  ATTR_PROVIDER,
  ATTR_PROVIDER_REQUEST_ID,
  ATTR_PROVIDER_THINKING_LEVEL,
  ATTR_REASONING_TOKENS,
  ATTR_REPO_SLUG,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_SESSION_ID,
  ATTR_THINKING_LEVEL,
  ATTR_TOOL_CALL_ID,
  ATTR_TOOL_NAME,
  ATTR_TOOL_OUTPUT_IMAGES,
  ATTR_TOOL_OUTPUT_SIZE,
  ATTR_TOOL_SCOPE,
  ATTR_TOOL_SOURCE,
  ATTR_TOOL_TRUNCATED_CALL,
  ATTR_USAGE_SOURCE,
  SPAN_AGENT_RUN,
  SPAN_COMPACTION,
  SPAN_INTERACTION,
  SPAN_LLM,
  SPAN_TOOL,
  SPAN_TURN,
  SPAN_USER_WAIT,
} from "./attributes.ts";
import { sanitizeError, type ToolOutputSummary } from "./sanitization.ts";
import type { TelemetryRuntime } from "./telemetry-types.ts";

interface SpanSlot {
  readonly span: Span;
  readonly context: Context;
  readonly startedAt: number;
}

interface ToolSlot extends SpanSlot {
  readonly name: string;
}

interface LlmSlot extends SpanSlot {
  readonly synthesized: boolean;
  providerError?: string;
  provider?: string;
  requestModel?: string;
  requestId?: string;
}

export interface SessionDetails {
  readonly sessionId: string;
  readonly project: string;
  readonly mode: string;
  readonly reason: string;
  readonly ephemeral: boolean;
  readonly cwd: string;
  readonly repoSlug?: string;
  readonly parentSessionId?: string;
}

export interface InputDetails {
  readonly source: string;
  readonly streamingBehavior?: string;
  readonly textLength: number;
  readonly imageCount: number;
}

export interface UsageDetails {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly cost?: number;
  readonly costInput?: number;
  readonly costOutput?: number;
  readonly costCacheRead?: number;
  readonly costCacheWrite?: number;
}

export type UsageSource = "assistant" | "tool" | "compaction" | "branch_summary";

export interface AssistantDetails {
  readonly provider?: string;
  readonly model?: string;
  readonly responseId?: string;
  readonly providerThinkingLevel?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly usage?: UsageDetails;
}

export interface LlmStartDetails {
  readonly provider?: string;
  readonly model?: string;
  readonly synthesized?: boolean;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly contextPercent?: number;
  readonly thinkingLevel?: string;
}

export interface ProviderResponseDetails {
  readonly status: number;
  readonly requestId?: string;
}

export interface ToolStartDetails {
  readonly source?: string;
  readonly scope?: string;
}

export interface CompactionStartDetails {
  readonly reason: string;
  readonly willRetry: boolean;
  readonly tokensBefore?: number;
}

function durationSeconds(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt) / 1_000;
}

function applyUsage(span: Span, usage: UsageDetails | undefined): void {
  if (!usage) return;
  if (usage.input !== undefined) span.setAttribute(ATTR_INPUT_TOKENS, usage.input);
  if (usage.output !== undefined) span.setAttribute(ATTR_OUTPUT_TOKENS, usage.output);
  if (usage.cacheRead !== undefined) span.setAttribute(ATTR_CACHE_READ_TOKENS, usage.cacheRead);
  if (usage.cacheWrite !== undefined) span.setAttribute(ATTR_CACHE_WRITE_TOKENS, usage.cacheWrite);
  if (usage.reasoning !== undefined) span.setAttribute(ATTR_REASONING_TOKENS, usage.reasoning);
  if (usage.cost !== undefined) span.setAttribute(ATTR_COST, usage.cost);
  if (usage.costInput !== undefined) span.setAttribute(ATTR_COST_INPUT, usage.costInput);
  if (usage.costOutput !== undefined) span.setAttribute(ATTR_COST_OUTPUT, usage.costOutput);
  if (usage.costCacheRead !== undefined)
    span.setAttribute(ATTR_COST_CACHE_READ, usage.costCacheRead);
  if (usage.costCacheWrite !== undefined)
    span.setAttribute(ATTR_COST_CACHE_WRITE, usage.costCacheWrite);
}

function errorOutcome(stopReason: string | undefined): boolean {
  return (
    stopReason === "error" ||
    stopReason === "aborted" ||
    stopReason === "incomplete" ||
    stopReason === "interrupted" ||
    stopReason === "superseded"
  );
}

export class AgentTelemetryTracker {
  private readonly runtime: TelemetryRuntime;
  private readonly now: () => number;
  private session: SessionDetails | undefined;
  private sessionStartedAt = 0;
  private interaction: SpanSlot | undefined;
  private run: SpanSlot | undefined;
  private turn: SpanSlot | undefined;
  private llm: LlmSlot | undefined;
  private wait: SpanSlot | undefined;
  private compaction: SpanSlot | undefined;
  private readonly tools = new Map<string, ToolSlot>();
  private pendingInput: InputDetails | undefined;
  private runCount = 0;
  private lastStopReason: string | undefined;
  private turnTruncated = false;

  constructor(runtime: TelemetryRuntime, now: () => number = Date.now) {
    this.runtime = runtime;
    this.now = now;
  }

  /** Attributes for spans and logs: identity, session, project, repository. */
  private baseAttributes(): Attributes {
    if (!this.session) return { ...this.runtime.commonAttributes };
    return {
      ...this.runtime.commonAttributes,
      [ATTR_SESSION_ID]: this.session.sessionId,
      [ATTR_CONVERSATION_ID]: this.session.sessionId,
      [ATTR_PROJECT]: this.session.project,
      [ATTR_MODE]: this.session.mode,
      ...(this.session.repoSlug ? { [ATTR_REPO_SLUG]: this.session.repoSlug } : {}),
      ...(this.session.parentSessionId
        ? { [ATTR_PARENT_SESSION_ID]: this.session.parentSessionId }
        : {}),
    };
  }

  /** Low-cardinality attributes shared by every metric point. */
  private metricAttributes(attributes: Attributes = {}): Attributes {
    return {
      ...(this.session ? { [ATTR_MODE]: this.session.mode } : {}),
      ...attributes,
    };
  }

  /**
   * Activity metrics (sessions, interactions, runs, turns, waits, inputs, interventions) also carry
   * the repository slug. Token, cost, LLM, and tool metrics do not: combined with provider, model,
   * tool name, and histogram buckets the series count would grow multiplicatively per user.
   */
  private activityMetricAttributes(attributes: Attributes = {}): Attributes {
    return this.metricAttributes({
      ...(this.session?.repoSlug ? { [ATTR_REPO_SLUG]: this.session.repoSlug } : {}),
      ...attributes,
    });
  }

  private startSpan(
    name: string,
    kind: SpanKind,
    attributes: Attributes,
    parent: Context,
  ): SpanSlot {
    const span = this.runtime.tracer.startSpan(
      name,
      { kind, attributes: { ...this.baseAttributes(), ...attributes } },
      parent,
    );
    return { span, context: trace.setSpan(parent, span), startedAt: this.now() };
  }

  private activeParent(): Context {
    return this.turn?.context ?? this.run?.context ?? this.interaction?.context ?? ROOT_CONTEXT;
  }

  private addInteractionEvent(name: string, attributes: Attributes): void {
    this.interaction?.span.addEvent(name, { ...this.baseAttributes(), ...attributes });
  }

  /** Close every child slot that may still be open, innermost first. */
  private drainChildren(reason: string): void {
    this.endCompaction({
      outcome: "interrupted",
      error: new Error(`Compaction interrupted by ${reason}`),
    });
    this.endWait("interrupted");
    this.endLlm({ stopReason: "interrupted" });
    for (const toolCallId of [...this.tools.keys()]) {
      this.endTool(toolCallId, true, new Error(`Tool span closed by ${reason}`));
    }
    this.endTurn("interrupted");
    this.endRun("interrupted");
  }

  startSession(details: SessionDetails): void {
    this.session = details;
    this.sessionStartedAt = this.now();
    const attributes = this.activityMetricAttributes({
      "pi.session.reason": details.reason,
      "pi.session.ephemeral": details.ephemeral,
    });
    this.runtime.metrics.count("pi.session.started", 1, attributes);
    this.runtime.logs.emit("info", "pi.session.started", "pi session started", {
      ...this.baseAttributes(),
      "pi.session.reason": details.reason,
      "pi.session.ephemeral": details.ephemeral,
    });
  }

  endSession(reason: string): void {
    const endedAt = this.now();
    if (this.interaction) this.endInteraction("session_shutdown");
    else this.drainChildren("session_shutdown");
    this.runtime.metrics.count(
      "pi.session.ended",
      1,
      this.activityMetricAttributes({ "pi.session.reason": reason }),
    );
    this.runtime.metrics.record(
      "pi.session.duration",
      durationSeconds(this.sessionStartedAt, endedAt),
      "s",
      this.activityMetricAttributes({ "pi.session.reason": reason }),
    );
    this.runtime.logs.emit("info", "pi.session.ended", "pi session ended", {
      ...this.baseAttributes(),
      "pi.session.reason": reason,
    });
    this.session = undefined;
  }

  noteInput(details: InputDetails): void {
    const attributes: Attributes = {
      "pi.input.source": details.source,
      "pi.input.text_length": details.textLength,
      "pi.input.image_count": details.imageCount,
      ...(details.streamingBehavior
        ? { "pi.input.streaming_behavior": details.streamingBehavior }
        : {}),
    };
    this.runtime.metrics.count(
      "pi.user.input.count",
      1,
      this.activityMetricAttributes({
        "pi.input.source": details.source,
        ...(details.streamingBehavior
          ? { "pi.input.streaming_behavior": details.streamingBehavior }
          : {}),
      }),
    );
    this.runtime.logs.emit(
      "info",
      "pi.user.input",
      "user input received",
      {
        ...this.baseAttributes(),
        ...attributes,
      },
      this.interaction?.context,
    );
    if (this.interaction) this.addInteractionEvent("pi.user.input", attributes);
    else this.pendingInput = details;
  }

  startInteraction(promptLength: number, imageCount: number): void {
    if (this.interaction) this.endInteraction("superseded");
    this.runCount = 0;
    this.lastStopReason = undefined;
    const pending = this.pendingInput;
    const attributes: Attributes = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "pi",
      "pi.prompt.length": promptLength,
      "pi.prompt.image_count": imageCount,
      ...(pending
        ? {
            "pi.input.source": pending.source,
            ...(pending.streamingBehavior
              ? { "pi.input.streaming_behavior": pending.streamingBehavior }
              : {}),
          }
        : {}),
    };
    this.pendingInput = undefined;
    this.interaction = this.startSpan(
      SPAN_INTERACTION,
      SpanKind.INTERNAL,
      attributes,
      ROOT_CONTEXT,
    );
    this.runtime.metrics.count("pi.interaction.count", 1, this.activityMetricAttributes());
  }

  endInteraction(outcome = "settled"): void {
    if (!this.interaction) return;
    this.drainChildren(outcome === "settled" ? "interaction end" : outcome);

    const endedAt = this.now();
    const failed = errorOutcome(this.lastStopReason) || outcome !== "settled";
    this.interaction.span.setAttributes({
      "pi.interaction.outcome": outcome,
      "pi.agent.run_count": this.runCount,
      ...(this.lastStopReason ? { "pi.stop_reason": this.lastStopReason } : {}),
    });
    this.interaction.span.setStatus(
      failed ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.OK },
    );
    this.interaction.span.end();
    this.runtime.metrics.record(
      "pi.interaction.duration",
      durationSeconds(this.interaction.startedAt, endedAt),
      "s",
      this.activityMetricAttributes({ outcome }),
    );
    this.runtime.logs.emit(
      failed ? "warn" : "info",
      "pi.interaction.settled",
      "pi interaction settled",
      {
        ...this.baseAttributes(),
        outcome,
        "pi.agent.run_count": this.runCount,
        ...(this.lastStopReason ? { "pi.stop_reason": this.lastStopReason } : {}),
      },
      this.interaction.context,
    );
    this.interaction = undefined;
  }

  startRun(): void {
    if (!this.interaction) return;
    if (this.run) this.endRun("superseded");
    this.runCount += 1;
    const repeated = this.runCount > 1;
    this.run = this.startSpan(
      SPAN_AGENT_RUN,
      SpanKind.INTERNAL,
      {
        "pi.agent.run_index": this.runCount,
        "pi.agent.run_repeated": repeated,
      },
      this.interaction.context,
    );
    this.runtime.metrics.count("pi.agent.run.count", 1, this.activityMetricAttributes());
    if (repeated) {
      this.runtime.metrics.count("pi.agent.retry.inferred", 1, this.activityMetricAttributes());
      this.addInteractionEvent("pi.agent.retry.inferred", { "pi.agent.run_index": this.runCount });
    }
  }

  endRun(stopReason?: string): void {
    if (!this.run) return;
    this.endLlm({ stopReason: "incomplete" });
    this.endTurn("incomplete");
    const endedAt = this.now();
    if (stopReason) this.lastStopReason = stopReason;
    if (stopReason === "aborted")
      this.userAction("abort_inferred", { "pi.abort.source": "agent_stop_reason" });
    const failed = errorOutcome(stopReason);
    this.run.span.setAttributes({ ...(stopReason ? { "pi.stop_reason": stopReason } : {}) });
    this.run.span.setStatus(failed ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.OK });
    this.run.span.end();
    this.runtime.metrics.record(
      "pi.agent.run.duration",
      durationSeconds(this.run.startedAt, endedAt),
      "s",
      this.activityMetricAttributes({ ...(stopReason ? { "pi.stop_reason": stopReason } : {}) }),
    );
    this.run = undefined;
  }

  startTurn(index: number): void {
    if (!this.interaction) return;
    if (this.turn) this.endTurn("superseded");
    this.turnTruncated = false;
    this.turn = this.startSpan(
      SPAN_TURN,
      SpanKind.INTERNAL,
      { "pi.turn.index": index },
      this.run?.context ?? this.interaction.context,
    );
    this.runtime.metrics.count("pi.turn.count", 1, this.activityMetricAttributes());
  }

  endTurn(outcome = "ok", assistant?: AssistantDetails, toolResultCount?: number): void {
    if (!this.turn) return;
    this.endWait("interrupted");
    this.endLlm(assistant ?? { stopReason: "incomplete" });
    for (const toolCallId of [...this.tools.keys()]) {
      this.endTool(toolCallId, true, new Error("Tool span closed before turn completion"));
    }
    const endedAt = this.now();
    const stopReason = assistant?.stopReason;
    if (stopReason) this.lastStopReason = stopReason;
    applyUsage(this.turn.span, assistant?.usage);
    this.turn.span.setAttributes({
      "pi.turn.outcome": outcome,
      ...(stopReason ? { "pi.stop_reason": stopReason } : {}),
      ...(toolResultCount !== undefined ? { "pi.turn.tool_result_count": toolResultCount } : {}),
    });
    this.turn.span.setStatus(
      errorOutcome(stopReason) || outcome !== "ok"
        ? { code: SpanStatusCode.ERROR }
        : { code: SpanStatusCode.OK },
    );
    this.turn.span.end();
    this.runtime.metrics.record(
      "pi.turn.duration",
      durationSeconds(this.turn.startedAt, endedAt),
      "s",
      this.activityMetricAttributes({ outcome }),
    );
    this.turn = undefined;
    this.turnTruncated = false;
  }

  hasOpenLlm(): boolean {
    return this.llm !== undefined;
  }

  startLlm(details: LlmStartDetails): void {
    if (this.llm) this.endLlm({ stopReason: "superseded" });
    const attributes: Attributes = {
      [ATTR_OPERATION]: "chat",
      ...(details.provider ? { [ATTR_PROVIDER]: details.provider } : {}),
      ...(details.model ? { [ATTR_REQUEST_MODEL]: details.model } : {}),
      ...(details.contextTokens !== undefined
        ? { [ATTR_CONTEXT_TOKENS]: details.contextTokens }
        : {}),
      ...(details.contextWindow !== undefined
        ? { [ATTR_CONTEXT_WINDOW]: details.contextWindow }
        : {}),
      ...(details.contextPercent !== undefined
        ? { [ATTR_CONTEXT_PERCENT]: details.contextPercent }
        : {}),
      ...(details.thinkingLevel ? { [ATTR_THINKING_LEVEL]: details.thinkingLevel } : {}),
      "pi.llm.synthesized": details.synthesized ?? false,
    };
    const slot = this.startSpan(SPAN_LLM, SpanKind.CLIENT, attributes, this.activeParent());
    this.llm = {
      ...slot,
      synthesized: details.synthesized ?? false,
      ...(details.provider ? { provider: details.provider } : {}),
      ...(details.model ? { requestModel: details.model } : {}),
    };
    const modelAttributes = this.metricAttributes({
      ...(details.provider ? { [ATTR_PROVIDER]: details.provider } : {}),
      ...(details.model ? { [ATTR_REQUEST_MODEL]: details.model } : {}),
    });
    this.runtime.metrics.count("pi.llm.requests", 1, modelAttributes);
    if (details.contextPercent !== undefined) {
      this.runtime.metrics.record(
        "pi.context.utilization",
        details.contextPercent,
        "%",
        modelAttributes,
      );
    }
  }

  noteProviderResponse(details: ProviderResponseDetails): void {
    if (!this.llm) return;
    if (details.requestId) this.llm.requestId = details.requestId;
    this.llm.span.setAttributes({
      "http.response.status_code": details.status,
      ...(details.requestId ? { [ATTR_PROVIDER_REQUEST_ID]: details.requestId } : {}),
    });
    if (details.status >= 400) {
      this.llm.providerError = `http_${details.status}`;
      this.llm.span.setAttribute(ATTR_ERROR_TYPE, this.llm.providerError);
      this.llm.span.setStatus({ code: SpanStatusCode.ERROR });
    }
  }

  endLlm(assistant: AssistantDetails): void {
    if (!this.llm) return;
    const endedAt = this.now();
    const provider = assistant.provider ?? this.llm.provider;
    const model = assistant.model;
    const failed = errorOutcome(assistant.stopReason) || this.llm.providerError !== undefined;
    const truncated = assistant.stopReason === "length";
    const errorType = this.llm.providerError ?? assistant.stopReason ?? "error";
    if (provider) this.llm.span.setAttribute(ATTR_PROVIDER, provider);
    if (model) this.llm.span.setAttribute(ATTR_RESPONSE_MODEL, model);
    const responseId = assistant.responseId ?? this.llm.requestId;
    if (responseId) this.llm.span.setAttribute(ATTR_RESPONSE_ID, responseId);
    if (assistant.providerThinkingLevel)
      this.llm.span.setAttribute(ATTR_PROVIDER_THINKING_LEVEL, assistant.providerThinkingLevel);
    if (assistant.stopReason)
      this.llm.span.setAttribute("gen_ai.response.finish_reasons", [assistant.stopReason]);
    if (truncated) this.llm.span.setAttribute(ATTR_LLM_TRUNCATED, true);
    applyUsage(this.llm.span, assistant.usage);
    const modelAttributes: Attributes = {
      ...(provider ? { [ATTR_PROVIDER]: provider } : {}),
      ...(model ? { [ATTR_RESPONSE_MODEL]: model } : {}),
    };
    if (failed) {
      this.llm.span.setAttribute(ATTR_ERROR_TYPE, errorType);
      this.llm.span.setStatus({ code: SpanStatusCode.ERROR });
      this.runtime.metrics.count(
        "pi.llm.errors",
        1,
        this.metricAttributes({
          ...(provider ? { [ATTR_PROVIDER]: provider } : {}),
          [ATTR_ERROR_TYPE]: errorType,
        }),
      );
      this.runtime.logs.emit(
        "error",
        "pi.llm.error",
        "LLM request failed",
        {
          ...this.baseAttributes(),
          ...modelAttributes,
          [ATTR_ERROR_TYPE]: errorType,
          ...(assistant.errorMessage ? { "error.message": assistant.errorMessage } : {}),
        },
        this.llm.context,
      );
    } else {
      this.llm.span.setStatus({ code: SpanStatusCode.OK });
    }
    if (truncated) {
      this.turnTruncated = true;
      this.runtime.metrics.count("pi.llm.truncated", 1, this.metricAttributes(modelAttributes));
    }
    this.llm.span.end();
    this.runtime.metrics.record(
      "pi.llm.duration",
      durationSeconds(this.llm.startedAt, endedAt),
      "s",
      this.metricAttributes({
        ...(provider ? { [ATTR_PROVIDER]: provider } : {}),
        ...(this.llm.requestModel ? { [ATTR_REQUEST_MODEL]: this.llm.requestModel } : {}),
        ...(model ? { [ATTR_RESPONSE_MODEL]: model } : {}),
        "pi.llm.synthesized": this.llm.synthesized,
      }),
    );
    this.recordUsageMetrics(assistant.usage, "assistant", provider, model);
    this.llm = undefined;
  }

  startTool(
    toolCallId: string,
    toolName: string,
    inputAttributes: Attributes,
    details: ToolStartDetails = {},
  ): void {
    if (this.tools.has(toolCallId))
      this.endTool(toolCallId, true, new Error("Duplicate tool start"));
    const slot = this.startSpan(
      SPAN_TOOL,
      SpanKind.INTERNAL,
      {
        [ATTR_OPERATION]: "execute_tool",
        [ATTR_TOOL_NAME]: toolName,
        [ATTR_TOOL_CALL_ID]: toolCallId,
        ...(details.source ? { [ATTR_TOOL_SOURCE]: details.source } : {}),
        ...(details.scope ? { [ATTR_TOOL_SCOPE]: details.scope } : {}),
        ...(this.turnTruncated ? { [ATTR_TOOL_TRUNCATED_CALL]: true } : {}),
        ...inputAttributes,
      },
      this.activeParent(),
    );
    this.tools.set(toolCallId, { ...slot, name: toolName });
    this.runtime.metrics.count(
      "pi.tool.calls",
      1,
      this.metricAttributes({
        [ATTR_TOOL_NAME]: toolName,
        ...(details.source ? { [ATTR_TOOL_SOURCE]: details.source } : {}),
      }),
    );
  }

  endTool(toolCallId: string, isError: boolean, error?: unknown, output?: ToolOutputSummary): void {
    const slot = this.tools.get(toolCallId);
    if (!slot) return;
    const endedAt = this.now();
    slot.span.setAttribute("pi.tool.is_error", isError);
    if (output) {
      slot.span.setAttributes({
        [ATTR_TOOL_OUTPUT_SIZE]: output.textLength,
        [ATTR_TOOL_OUTPUT_IMAGES]: output.imageCount,
      });
    }
    if (isError) {
      const sanitized = sanitizeError(error, this.session?.cwd ?? process.cwd());
      slot.span.setAttribute(ATTR_ERROR_TYPE, sanitized.type);
      if (sanitized.message) slot.span.setAttribute("error.message", sanitized.message);
      slot.span.setStatus({ code: SpanStatusCode.ERROR });
      this.runtime.metrics.count(
        "pi.tool.errors",
        1,
        this.metricAttributes({
          [ATTR_TOOL_NAME]: slot.name,
          [ATTR_ERROR_TYPE]: sanitized.type,
        }),
      );
      this.runtime.logs.emit(
        "error",
        "pi.tool.error",
        "tool execution failed",
        {
          ...this.baseAttributes(),
          [ATTR_TOOL_NAME]: slot.name,
          [ATTR_TOOL_CALL_ID]: toolCallId,
          [ATTR_ERROR_TYPE]: sanitized.type,
          ...(sanitized.message ? { "error.message": sanitized.message } : {}),
        },
        slot.context,
      );
    } else {
      slot.span.setStatus({ code: SpanStatusCode.OK });
    }
    slot.span.end();
    this.tools.delete(toolCallId);
    this.runtime.metrics.record(
      "pi.tool.duration",
      durationSeconds(slot.startedAt, endedAt),
      "s",
      this.metricAttributes({ [ATTR_TOOL_NAME]: slot.name, outcome: isError ? "error" : "ok" }),
    );
  }

  startWait(kind: string): void {
    if (this.wait) return;
    this.wait = this.startSpan(
      SPAN_USER_WAIT,
      SpanKind.INTERNAL,
      {
        "pi.user.intervention": "ui_prompt",
        "pi.ui.prompt_kind": kind,
      },
      this.activeParent(),
    );
    this.runtime.metrics.count(
      "pi.user.intervention.count",
      1,
      this.activityMetricAttributes({ kind: "ui_prompt" }),
    );
  }

  endWait(outcome = "completed"): void {
    if (!this.wait) return;
    const endedAt = this.now();
    this.wait.span.setAttribute("pi.user.wait.outcome", outcome);
    this.wait.span.setStatus(
      outcome === "completed" ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR },
    );
    this.wait.span.end();
    this.runtime.metrics.record(
      "pi.user.wait.duration",
      durationSeconds(this.wait.startedAt, endedAt),
      "s",
      this.activityMetricAttributes({ outcome }),
    );
    this.wait = undefined;
  }

  userAction(kind: string, attributes: Attributes = {}): void {
    const eventAttributes = { "pi.user.intervention": kind, ...attributes };
    this.runtime.metrics.count(
      "pi.user.intervention.count",
      1,
      this.activityMetricAttributes({ kind }),
    );
    this.runtime.logs.emit(
      "info",
      "pi.user.intervention",
      "user intervention observed",
      {
        ...this.baseAttributes(),
        ...eventAttributes,
      },
      this.interaction?.context,
    );
    this.addInteractionEvent("pi.user.intervention", eventAttributes);
  }

  operationalEvent(eventName: string, attributes: Attributes = {}): void {
    this.runtime.logs.emit(
      "info",
      eventName,
      "pi operational event observed",
      {
        ...this.baseAttributes(),
        ...attributes,
      },
      this.interaction?.context,
    );
    this.addInteractionEvent(eventName, attributes);
  }

  /** Record a telemetry-pipeline failure inside the extension itself (handler threw, etc.). */
  noteInternalFailure(reason: string): void {
    this.runtime.metrics.count("pi.telemetry.dropped", 1, { "otel.signal": "handler", reason });
  }

  startCompaction(details: CompactionStartDetails): void {
    if (this.compaction) this.endCompaction({ outcome: "superseded" });
    this.compaction = this.startSpan(
      SPAN_COMPACTION,
      SpanKind.INTERNAL,
      {
        "pi.compaction.reason": details.reason,
        "pi.compaction.will_retry": details.willRetry,
        ...(details.tokensBefore !== undefined
          ? { "pi.compaction.tokens_before": details.tokensBefore }
          : {}),
      },
      this.interaction?.context ?? ROOT_CONTEXT,
    );
    this.runtime.metrics.count(
      "pi.compaction.count",
      1,
      this.metricAttributes({ reason: details.reason }),
    );
    if (details.reason === "manual") this.userAction("manual_compaction");
  }

  endCompaction(details: {
    outcome: string;
    fromExtension?: boolean;
    error?: unknown;
    usage?: UsageDetails;
  }): void {
    if (!this.compaction) return;
    const endedAt = this.now();
    this.compaction.span.setAttributes({
      "pi.compaction.outcome": details.outcome,
      ...(details.fromExtension !== undefined
        ? { "pi.compaction.from_extension": details.fromExtension }
        : {}),
    });
    applyUsage(this.compaction.span, details.usage);
    if (details.error || details.outcome === "failed" || details.outcome === "aborted") {
      const sanitized = sanitizeError(details.error, this.session?.cwd ?? process.cwd());
      this.compaction.span.setAttribute(ATTR_ERROR_TYPE, sanitized.type);
      if (sanitized.message) this.compaction.span.setAttribute("error.message", sanitized.message);
      this.compaction.span.setStatus({ code: SpanStatusCode.ERROR });
      this.runtime.logs.emit(
        "error",
        "pi.compaction.failed",
        "session compaction failed",
        {
          ...this.baseAttributes(),
          "pi.compaction.outcome": details.outcome,
          [ATTR_ERROR_TYPE]: sanitized.type,
          ...(sanitized.message ? { "error.message": sanitized.message } : {}),
        },
        this.compaction.context,
      );
    } else {
      this.compaction.span.setStatus({ code: SpanStatusCode.OK });
    }
    this.compaction.span.end();
    this.runtime.metrics.record(
      "pi.compaction.duration",
      durationSeconds(this.compaction.startedAt, endedAt),
      "s",
      this.metricAttributes({ outcome: details.outcome }),
    );
    this.compaction = undefined;
    if (details.usage) this.recordUsageMetrics(details.usage, "compaction");
  }

  /** Usage produced outside the main assistant stream: tool-side LLM work or branch summaries. */
  recordAuxiliaryUsage(
    source: Exclude<UsageSource, "assistant">,
    usage: UsageDetails | undefined,
    provider?: string,
    model?: string,
  ): void {
    if (!usage) return;
    this.recordUsageMetrics(usage, source, provider, model);
  }

  private recordUsageMetrics(
    usage: UsageDetails | undefined,
    source: UsageSource,
    provider?: string,
    model?: string,
  ): void {
    if (!usage) return;
    const attributes: Attributes = {
      [ATTR_USAGE_SOURCE]: source,
      ...(provider ? { [ATTR_PROVIDER]: provider } : {}),
      ...(model ? { [ATTR_RESPONSE_MODEL]: model } : {}),
    };
    if (usage.input !== undefined)
      this.runtime.metrics.count("pi.tokens.input", usage.input, attributes);
    if (usage.output !== undefined)
      this.runtime.metrics.count("pi.tokens.output", usage.output, attributes);
    if (usage.cacheRead !== undefined)
      this.runtime.metrics.count("pi.tokens.cache_read", usage.cacheRead, attributes);
    if (usage.cacheWrite !== undefined)
      this.runtime.metrics.count("pi.tokens.cache_write", usage.cacheWrite, attributes);
    if (usage.reasoning !== undefined)
      this.runtime.metrics.count("pi.tokens.reasoning", usage.reasoning, attributes);
    if (usage.cost !== undefined) this.runtime.metrics.count("pi.cost", usage.cost, attributes);
  }
}
