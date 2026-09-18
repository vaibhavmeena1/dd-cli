import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig as defaultResolveConfig, type OrgTelemetryConfig } from "./config.ts";
import {
  readPiVersion as defaultReadPiVersion,
  describeEnvironment,
  type ResourceEnvironment,
} from "./environment.ts";
import {
  resolveIdentity as defaultResolveIdentity,
  type IdentityOptions,
  type TelemetryIdentity,
} from "./identity.ts";
import { createOtelRuntime, type RuntimeOptions } from "./otel/runtime.ts";
import { resolveRepoSlug as defaultResolveRepoSlug, type RepoSlugOptions } from "./repo.ts";
import {
  sanitizeText,
  summarizeShellCommand,
  summarizeToolInput,
  summarizeToolOutput,
} from "./sanitization.ts";
import type { TelemetryRuntime } from "./telemetry-types.ts";
import {
  AgentTelemetryTracker,
  type AssistantDetails,
  type LlmStartDetails,
  type ToolStartDetails,
  type UsageDetails,
} from "./tracker.ts";

export interface TelemetryDependencies {
  readonly resolveConfig: (env?: NodeJS.ProcessEnv) => OrgTelemetryConfig | undefined;
  readonly resolveIdentity: (options: IdentityOptions) => Promise<TelemetryIdentity>;
  readonly resolveRepoSlug: (options: RepoSlugOptions) => Promise<string | undefined>;
  readonly readPiVersion: () => Promise<string | undefined>;
  readonly createRuntime: (
    config: OrgTelemetryConfig,
    identity: TelemetryIdentity,
    environment: ResourceEnvironment,
    options: RuntimeOptions,
  ) => TelemetryRuntime;
}

const defaultDependencies: TelemetryDependencies = {
  resolveConfig: defaultResolveConfig,
  resolveIdentity: defaultResolveIdentity,
  resolveRepoSlug: defaultResolveRepoSlug,
  readPiVersion: defaultReadPiVersion,
  createRuntime: createOtelRuntime,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(
  record: Record<string, unknown> | undefined,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function finiteNumber(
  record: Record<string, unknown> | undefined,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function summarizeUsage(value: unknown): UsageDetails | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = finiteNumber(usage, "input", "inputTokens", "input_tokens");
  const output = finiteNumber(usage, "output", "outputTokens", "output_tokens");
  const cacheRead = finiteNumber(usage, "cacheRead", "cacheReadTokens", "cache_read_input_tokens");
  const cacheWrite = finiteNumber(
    usage,
    "cacheWrite",
    "cacheWriteTokens",
    "cache_creation_input_tokens",
  );
  const reasoning = finiteNumber(usage, "reasoning", "reasoningTokens", "reasoning_tokens");
  const costValue = usage.cost;
  const costRecord = asRecord(costValue);
  const cost =
    typeof costValue === "number" && Number.isFinite(costValue)
      ? costValue
      : finiteNumber(costRecord, "total");
  const costInput = finiteNumber(costRecord, "input");
  const costOutput = finiteNumber(costRecord, "output");
  const costCacheRead = finiteNumber(costRecord, "cacheRead");
  const costCacheWrite = finiteNumber(costRecord, "cacheWrite");
  const result: UsageDetails = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(costInput !== undefined ? { costInput } : {}),
    ...(costOutput !== undefined ? { costOutput } : {}),
    ...(costCacheRead !== undefined ? { costCacheRead } : {}),
    ...(costCacheWrite !== undefined ? { costCacheWrite } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function summarizeAssistant(value: unknown, cwd: string): AssistantDetails {
  const message = asRecord(value);
  if (message?.role !== "assistant") return {};
  const provider = stringValue(message, "provider");
  // `responseModel` is the provider-reported model; `model` is the requested one.
  const model = stringValue(message, "responseModel") ?? stringValue(message, "model");
  const responseId = stringValue(message, "responseId");
  const providerThinkingLevel = stringValue(message, "providerThinkingLevel");
  const stopReason = stringValue(message, "stopReason", "finishReason", "finish_reason");
  const rawError = stringValue(message, "errorMessage", "error_message");
  const usage = summarizeUsage(message.usage);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(responseId ? { responseId } : {}),
    ...(providerThinkingLevel ? { providerThinkingLevel } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(rawError ? { errorMessage: sanitizeText(rawError, cwd) } : {}),
    ...(usage ? { usage } : {}),
  };
}

function lastAssistant(messages: readonly unknown[], cwd: string): AssistantDetails {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role === "assistant") return summarizeAssistant(message, cwd);
  }
  return {};
}

function requestModel(payload: unknown): string | undefined {
  return stringValue(asRecord(payload), "model", "modelId", "modelName");
}

const REQUEST_ID_HEADERS = [
  "x-request-id",
  "request-id",
  "anthropic-request-id",
  "openai-response-id",
  "cf-ray",
];

function providerRequestId(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const lowercase = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string" && value) lowercase.set(name.toLowerCase(), value);
  }
  for (const name of REQUEST_ID_HEADERS) {
    const value = lowercase.get(name);
    if (value) return value;
  }
  return undefined;
}

/** Context-window state at request time; getters may throw on a stale runtime, so guard them. */
function contextDetails(ctx: ExtensionContext): Partial<LlmStartDetails> {
  try {
    const usage = ctx.getContextUsage();
    const thinkingLevel = ctx.thinkingLevel;
    return {
      ...(usage && typeof usage.tokens === "number" && Number.isFinite(usage.tokens)
        ? { contextTokens: usage.tokens }
        : {}),
      ...(usage && Number.isFinite(usage.contextWindow)
        ? { contextWindow: usage.contextWindow }
        : {}),
      ...(usage && typeof usage.percent === "number" && Number.isFinite(usage.percent)
        ? { contextPercent: usage.percent }
        : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  } catch {
    return {};
  }
}

function classifyToolSource(source: string | undefined): string {
  if (!source) return "unknown";
  if (source === "builtin" || source === "sdk") return source;
  return "extension";
}

function safeRuntimeFailure(
  diagnostics: boolean,
  quiet: boolean,
  error: unknown,
  cwd: string,
): void {
  if (!diagnostics || quiet) return;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pi-org-telemetry] initialization failed: ${sanitizeText(message, cwd)}\n`);
}

/**
 * Build the extension factory with injectable dependencies (used by tests). The default export
 * below keeps pi's `(pi: ExtensionAPI) => void` loader contract unchanged.
 */
export function createPiOrgTelemetry(
  overrides: Partial<TelemetryDependencies> = {},
): (pi: ExtensionAPI) => void {
  const deps: TelemetryDependencies = { ...defaultDependencies, ...overrides };

  return function piOrgTelemetry(pi: ExtensionAPI): void {
    let runtime: TelemetryRuntime | undefined;
    let tracker: AgentTelemetryTracker | undefined;
    let pendingProjectTrust: string | undefined;
    let cwd = process.cwd();
    let toolSources: Map<string, { source: string; scope: string }> | undefined;

    /** Telemetry must never throw into pi. Failures are counted and swallowed. */
    function guard<E>(
      name: string,
      handler: (event: E, ctx: ExtensionContext) => void | Promise<void>,
    ) {
      return (event: E, ctx: ExtensionContext): void | Promise<void> => {
        const fail = (): void => {
          try {
            tracker?.noteInternalFailure(name);
          } catch {
            // Nothing else to do; telemetry is best effort.
          }
        };
        try {
          const result = handler(event, ctx);
          if (result instanceof Promise) return result.catch(fail);
          return result;
        } catch {
          fail();
          return undefined;
        }
      };
    }

    function toolProvenance(toolName: string): ToolStartDetails {
      const lookup = (): { source: string; scope: string } | undefined =>
        toolSources?.get(toolName);
      let found = lookup();
      if (!found) {
        toolSources = new Map();
        for (const tool of pi.getAllTools()) {
          toolSources.set(tool.name, {
            source: classifyToolSource(tool.sourceInfo?.source),
            scope: tool.sourceInfo?.scope ?? "unknown",
          });
        }
        found = lookup();
      }
      return found ?? { source: "unknown", scope: "unknown" };
    }

    pi.on("project_trust", (event) => {
      try {
        pendingProjectTrust = basename(event.cwd);
      } catch {
        // Passive observer: never influence the trust decision.
      }
      return { trusted: "undecided" };
    });

    pi.on(
      "session_start",
      guard("session_start", async (event, ctx) => {
        const config = deps.resolveConfig();
        if (!config) return;
        cwd = ctx.cwd;
        const quiet = ctx.mode === "tui";
        try {
          if (runtime) {
            const previous = runtime;
            runtime = undefined;
            tracker = undefined;
            await previous.shutdown();
          }
          const [identity, repoSlug, piVersion] = await Promise.all([
            deps.resolveIdentity({ cwd: ctx.cwd }),
            deps.resolveRepoSlug({ cwd: ctx.cwd }),
            deps.readPiVersion(),
          ]);
          runtime = deps.createRuntime(config, identity, describeEnvironment(piVersion), { quiet });
          tracker = new AgentTelemetryTracker(runtime);
          const sessionId = ctx.sessionManager.getSessionId();
          const sessionFile = ctx.sessionManager.getSessionFile();
          const inheritedSessionId = process.env.PI_SESSION_ID?.trim();
          tracker.startSession({
            sessionId,
            project: basename(ctx.cwd),
            mode: ctx.mode,
            reason: event.reason,
            ephemeral: sessionFile === undefined,
            cwd: ctx.cwd,
            ...(repoSlug ? { repoSlug } : {}),
            ...(inheritedSessionId && inheritedSessionId !== sessionId
              ? { parentSessionId: inheritedSessionId }
              : {}),
          });
          if (pendingProjectTrust) {
            tracker.operationalEvent("pi.project.trust_requested", {
              "pi.project.name": pendingProjectTrust,
            });
            pendingProjectTrust = undefined;
          }
        } catch (error: unknown) {
          safeRuntimeFailure(config.diagnostics, quiet, error, ctx.cwd);
          tracker = undefined;
          runtime = undefined;
        }
      }),
    );

    pi.on(
      "session_shutdown",
      guard("session_shutdown", async (event) => {
        tracker?.endSession(event.reason);
        tracker = undefined;
        const currentRuntime = runtime;
        runtime = undefined;
        await currentRuntime?.shutdown();
      }),
    );

    pi.on(
      "input",
      guard("input", (event) => {
        tracker?.noteInput({
          source: event.source,
          ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}),
          textLength: event.text.length,
          imageCount: event.images?.length ?? 0,
        });
        if (event.streamingBehavior) {
          tracker?.userAction(event.streamingBehavior === "steer" ? "steer" : "follow_up", {
            "pi.input.source": event.source,
          });
        }
      }),
    );

    pi.on(
      "before_agent_start",
      guard("before_agent_start", (event) => {
        tracker?.startInteraction(event.prompt.length, event.images?.length ?? 0);
      }),
    );

    pi.on(
      "agent_start",
      guard("agent_start", () => tracker?.startRun()),
    );

    pi.on(
      "agent_end",
      guard("agent_end", (event) => {
        tracker?.endRun(lastAssistant(event.messages, cwd).stopReason);
      }),
    );

    pi.on(
      "agent_settled",
      guard("agent_settled", () => tracker?.endInteraction("settled")),
    );

    pi.on(
      "turn_start",
      guard("turn_start", (event) => tracker?.startTurn(event.turnIndex)),
    );

    pi.on(
      "turn_end",
      guard("turn_end", (event) => {
        tracker?.endTurn("ok", summarizeAssistant(event.message, cwd), event.toolResults.length);
      }),
    );

    pi.on(
      "before_provider_request",
      guard("before_provider_request", (event, ctx) => {
        if (!tracker) return;
        const model = requestModel(event.payload) ?? ctx.model?.id;
        tracker.startLlm({
          ...(ctx.model?.provider ? { provider: ctx.model.provider } : {}),
          ...(model ? { model } : {}),
          ...contextDetails(ctx),
        });
      }),
    );

    pi.on(
      "after_provider_response",
      guard("after_provider_response", (event) => {
        const requestId = providerRequestId(event.headers);
        tracker?.noteProviderResponse({
          status: event.status,
          ...(requestId ? { requestId } : {}),
        });
      }),
    );

    pi.on(
      "message_start",
      guard("message_start", (event, ctx) => {
        const message = asRecord(event.message);
        if (!tracker || message?.role !== "assistant" || tracker.hasOpenLlm()) return;
        const provider = stringValue(message, "provider");
        const model = stringValue(message, "model");
        tracker.startLlm({
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...contextDetails(ctx),
          synthesized: true,
        });
      }),
    );

    pi.on(
      "message_end",
      guard("message_end", (event) => {
        const message = asRecord(event.message);
        if (message?.role === "assistant") tracker?.endLlm(summarizeAssistant(message, cwd));
      }),
    );

    pi.on(
      "tool_execution_start",
      guard("tool_execution_start", (event, ctx) => {
        tracker?.startTool(
          event.toolCallId,
          event.toolName,
          summarizeToolInput(event.toolName, event.args, ctx.cwd),
          toolProvenance(event.toolName),
        );
      }),
    );

    pi.on(
      "tool_execution_end",
      guard("tool_execution_end", (event) => {
        if (!tracker) return;
        tracker.endTool(
          event.toolCallId,
          event.isError,
          event.isError ? new ToolExecutionError() : undefined,
          summarizeToolOutput(event.result),
        );
        const usage = summarizeUsage(asRecord(event.result)?.usage);
        if (usage) tracker.recordAuxiliaryUsage("tool", usage);
      }),
    );

    pi.on(
      "ui_prompt_start",
      guard("ui_prompt_start", (event) => tracker?.startWait(event.kind)),
    );
    pi.on(
      "ui_prompt_end",
      guard("ui_prompt_end", () => tracker?.endWait()),
    );

    pi.on(
      "session_before_compact",
      guard("session_before_compact", (event) => {
        tracker?.startCompaction({
          reason: event.reason,
          willRetry: event.willRetry,
          ...(event.preparation.tokensBefore !== undefined
            ? { tokensBefore: event.preparation.tokensBefore }
            : {}),
        });
      }),
    );

    pi.on(
      "session_compact",
      guard("session_compact", (event) => {
        const usage = summarizeUsage(event.compactionEntry.usage);
        tracker?.endCompaction({
          outcome: "ok",
          fromExtension: event.fromExtension,
          ...(usage ? { usage } : {}),
        });
      }),
    );

    pi.on(
      "session_compact_failed",
      guard("session_compact_failed", (event) => {
        if (event.aborted) {
          tracker?.userAction("compaction_abort_inferred", {
            "pi.compaction.reason": event.reason,
          });
        }
        tracker?.endCompaction({
          outcome: event.aborted ? "aborted" : "failed",
          fromExtension: event.fromExtension,
          ...(event.errorMessage
            ? { error: new Error(sanitizeText(event.errorMessage, cwd)) }
            : {}),
        });
      }),
    );

    pi.on(
      "model_select",
      guard("model_select", (event) => {
        const attributes = {
          "pi.model.source": event.source,
          "gen_ai.provider.name": event.model.provider,
          "gen_ai.request.model": event.model.id,
          ...(event.previousModel
            ? { "pi.model.previous": `${event.previousModel.provider}/${event.previousModel.id}` }
            : {}),
        };
        if (event.source === "restore") tracker?.operationalEvent("pi.model.restored", attributes);
        else tracker?.userAction("model_change", attributes);
      }),
    );

    pi.on(
      "thinking_level_select",
      guard("thinking_level_select", (event) => {
        tracker?.userAction("thinking_level_change", {
          "pi.thinking.level": event.level,
          "pi.thinking.previous_level": event.previousLevel,
        });
      }),
    );

    pi.on(
      "user_bash",
      guard("user_bash", (event) => {
        tracker?.userAction("user_bash", {
          ...summarizeShellCommand(event.command, event.cwd),
          "pi.command.excluded_from_context": event.excludeFromContext,
        });
      }),
    );

    pi.on(
      "session_before_switch",
      guard("session_before_switch", (event) => {
        tracker?.userAction("session_switch_requested", {
          "pi.session.switch_reason": event.reason,
        });
      }),
    );

    pi.on(
      "session_before_fork",
      guard("session_before_fork", (event) => {
        tracker?.userAction("session_fork_requested", {
          "pi.session.fork_position": event.position,
        });
      }),
    );

    pi.on(
      "session_before_tree",
      guard("session_before_tree", () => tracker?.userAction("session_tree_requested")),
    );
    pi.on(
      "session_tree",
      guard("session_tree", (event) => {
        tracker?.operationalEvent("pi.session.tree_completed", {
          "pi.session.tree_summarized": event.summaryEntry !== undefined,
        });
        tracker?.recordAuxiliaryUsage("branch_summary", summarizeUsage(event.summaryEntry?.usage));
      }),
    );
    pi.on(
      "session_info_changed",
      guard("session_info_changed", () => tracker?.userAction("session_name_changed")),
    );

    // Intentionally do not handle before_provider_headers: organization policy selected no gateway injection.
  };
}

/** Stable classification for failed tool executions; raw tool output is never inspected. */
class ToolExecutionError extends Error {
  constructor() {
    super("Tool execution failed");
    this.name = "tool_execution_error";
  }
}

export default function piOrgTelemetry(pi: ExtensionAPI): void {
  createPiOrgTelemetry()(pi);
}
