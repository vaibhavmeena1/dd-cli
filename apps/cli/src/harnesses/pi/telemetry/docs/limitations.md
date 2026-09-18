# Known limitations

The package observes the public coding-agent extension API. It does not receive private `AgentHarness` telemetry contexts or export internal spans created only through `@earendil-works/pi-telemetry`.

Current public-event limitations:

- there is no generic event for every built-in slash command;
- Esc abort has no dedicated event and is inferred from assistant/compaction outcomes;
- repeated `agent_start` before `agent_settled` is labeled as an inferred retry, but may represent another automatic continuation;
- failures inside unrelated extension handlers are logged by pi but are not exposed to this extension;
- another extension's final `tool_call` block decision is not directly exposed to passive observers;
- provider hooks vary by transport, so custom providers may require synthesized LLM spans and may not expose response headers, HTTP status, or request IDs;
- `gen_ai.response.model` is only distinct from the requested model for providers that report it (currently OpenAI-compatible completions); others repeat the request model;
- `user_bash` exposes command start/interception but no passive completion event;
- UI prompt events do not identify the tool that opened the prompt, so wait spans attach to the active turn rather than a specific parallel tool;
- `pi.context.*` is absent on the first request after a compaction because pi reports unknown usage until the next response;
- when a response stops for `length`, pi fails every tool call in that response, so `pi.tool.errors` rises together with `pi.llm.truncated`; those tool spans carry `pi.tool.truncated_call=true`;
- `pi.repo.slug` only considers the `origin` remote;
- `pi.version` is only available when pi's package can be imported from the extension's runtime, which is the normal case under `pi` but not guaranteed in embedded SDK hosts.

The extension does not inject distributed trace context into AI gateway or shell requests. Gateway records must be correlated independently using `pi.provider.request_id`, model, user, and timestamps where available.

Pi emits `session_shutdown` on quit, SIGINT, SIGTERM, and SIGHUP, and the extension flushes within two seconds. A SIGKILL or crash loses at most one batch window of unexported spans and logs.

The fixed redaction policy covers common credential forms but cannot prove arbitrary free-form summaries contain no sensitive text. Prompt/completion content and tool results are excluded entirely to reduce that risk.
