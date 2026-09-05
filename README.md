# DeputyDev CLI

Native Bun/TypeScript launcher for running supported coding harnesses with DeputyDev-managed configuration and resources. The current executable name is `deputydev2`; the stable product identity is `deputydev`.

## Current status

**Launcher Phase 1 and Pi resource/package isolation are implemented.** The CLI resolves and directly starts Pi and OpenCode while preserving the harness argument boundary. Pi launches use dedicated DeputyDev agent/session directories, a content-addressed DeputyDev resource runtime, and embedded required-package policy; auth onboarding, OpenCode profiles/provisioning, and updating remain later phases.

### Implemented

- Bun 1.4.1, strict TypeScript, Biome, and native `darwin-arm64` compilation
- Product identity, build metadata, service-origin validation, and managed paths
- Pre-Commander dispatch for `pi`, `opencode`, and the `opencode2` alias
- Pi-only setup checks, including append-only organization MCP defaults at `~/.config/mcp/mcp.json`
- Pi agent/session isolation under `${DEPUTYDEV_HOME}/pi`, with Pi version checks disabled and inherited Anthropic/OpenAI API keys removed from Pi only
- Content-addressed, checksum-verified DeputyDev Pi resources injected through explicit Pi flags
- Embedded required-package policy with exact, minimum, and Pi/user-managed floating versions
- Locked package reconciliation, last-known-good exact fallback, and local-only warm checks
- Executable overrides and PATH resolution without shell evaluation
- Exact harness-argument passthrough and inherited stdio/cwd
- DeputyDev control-variable stripping and redacted debug launch previews
- Child exit-code and signal-status propagation
- `harnesses`, `paths`, basic `doctor`, and guarded `uninstall` commands
- Launcher-core tests for registry behavior, environment isolation, argv passthrough, aliases, and reserved exit statuses

### Deferred

- Phase 0 compatibility evidence and the complete Phase 0.5 PTY/import-boundary suite
- Pi auth import and onboarding
- OpenCode profile isolation, standalone policy, resources, and provisioning
- Installer, release pipeline, signed manifests, and updater behavior

## Usage

```bash
deputydev2 pi [pi arguments...]
deputydev2 opencode [opencode arguments...]
deputydev2 opencode2 [opencode arguments...] # compatibility alias
```

Everything after the harness token bypasses Commander and retains its token order. For example, `deputydev2 pi --help` launches `pi --help`. Ordinary Pi sessions are prefixed with explicit DeputyDev-owned resource flags; Pi help/version and package administration commands remain unchanged.

Launcher-owned commands:

```bash
deputydev2 harnesses
deputydev2 paths
deputydev2 doctor [pi|opencode|opencode2]
deputydev2 setup pi --sync-packages
deputydev2 uninstall [--remove-runtimes] [--remove-profiles]
```

`uninstall` only mutates an installation when the running executable is the managed binary at `~/.deputydev/bin/deputydev2`. The dedicated Pi directory is preserved. OpenCode profiles and cached runtimes are also preserved unless their explicit removal flags are supplied.

Set `DEPUTYDEV_DEBUG=1` for a redacted launch preview on stderr. Harness executable overrides are `DEPUTYDEV_PI_BIN` and `DEPUTYDEV_OPENCODE_BIN`.

### Pi data isolation

Every `deputydev2 pi` launch sets:

```text
PI_CODING_AGENT_DIR=${DEPUTYDEV_HOME}/pi
PI_CODING_AGENT_SESSION_DIR=${DEPUTYDEV_HOME}/pi/sessions
```

With the default DeputyDev home, these resolve to `~/.deputydev/pi` and `~/.deputydev/pi/sessions`. Pi settings, auth, installed npm/git packages, temporary package caches, and sessions used through DeputyDev therefore remain separate from the user's normal `~/.pi/agent` directory. The values override inherited `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` settings, including for forwarded Pi package commands.

Pi launches set `PI_SKIP_VERSION_CHECK=1` to disable Pi's startup version request. They also remove inherited `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` values so Pi does not use those ambient credentials. These policies are Pi-specific; OpenCode remains unchanged. The shared environment builder applies the adapter-owned overrides without mutating `process.env`.

### Pi resources and required packages

DeputyDev-owned extensions, skills, prompts, and themes are embedded in the CLI, materialized under `${DEPUTYDEV_HOME}/runtime/<version>-<hash>/pi`, checksum-verified, and activated through the stable `runtime/current` symlink. Ordinary Pi sessions receive explicit resource arguments. The initial core extension provides `/deputydev-status`. Resource source has an independent Pi extension typecheck.

The embedded manifest in `src/product/manifest.ts` declares required community packages. It currently keeps `pi-mcp-adapter` and `@juicesharp/rpiv-ask-user-question` floating so Pi or the user can upgrade them, while `pi-provider-litellm` is locked to version `2.3.0`. Package entries support:

- `exact`: only the declared version is accepted; a failed migration may use a verified, non-revoked last-known-good exact version
- `minimum`: the declared version is a hard floor; newer installed versions are accepted and never downgraded
- `floating`: no DeputyDev version constraint; Pi or the user may update it at any time

Minimum and floating entries remain eligible for native `deputydev2 pi update --extensions`. DeputyDev does not query registries or schedule updates for healthy minimum/floating packages. It only installs a missing package, repairs a below-minimum package, or restores the required unfiltered settings entry. Exact versions change only with a new embedded DeputyDev manifest.

A first ordinary interactive launch installs missing required packages with visible progress. Print, JSON/RPC, piped, CI, and other non-interactive launches perform no package installation network work and instead direct the user to:

```bash
deputydev2 setup pi --sync-packages
```

Package checks inspect `${DEPUTYDEV_HOME}/pi/settings.json` and installed package metadata directly; they do not parse `pi list`. State is written to `${DEPUTYDEV_HOME}/pi-packages.json`, synchronization uses a same-user lock, and unrelated user package entries are preserved. If a later manifest removes a package, DeputyDev removes it only when state and unchanged metadata prove it is still DeputyDev-owned.

> **Security:** Pi packages run with full user permissions. Extensions, skills, dependency install scripts, and update commands can execute code. Treat every required package and manifest change as release-grade code.

See [`plans/pi-package-provisioning.md`](plans/pi-package-provisioning.md) for the manifest schema, lifecycle decisions, and verification plan.

### Pi MCP defaults

Before Pi starts, DeputyDev requests the organization MCP catalog from:

```text
${BUILD_SERVICE_ORIGIN}/v1/cli/pi/mcp.json
```

The endpoint returns a standard MCP config shape:

```json
{
  "mcpServers": {
    "organization-tool": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

DeputyDev creates `~/.config/mcp/mcp.json` with mode `0600` when it is missing. Every fetched server is written with `"disabled": true`, regardless of the endpoint value. On later runs it only appends server names that are absent locally:

- existing server definitions and enabled/disabled choices are never replaced
- personal servers are preserved
- servers removed from the organization catalog remain in the user's file
- remote settings and other top-level fields are not copied
- invalid local files are left byte-for-byte unchanged

The request is best-effort and capped at 700 ms. If it is unavailable on first run, DeputyDev creates a safe empty `mcpServers` scaffold and retries on later Pi launches. Setup failures never prevent Pi from starting; details are shown with `DEPUTYDEV_DEBUG=1`.

## Development

Bun must be available in your shell. The repository pins Bun `1.4.1`.

```bash
bun install --frozen-lockfile
bun run check
bun test
bun run dev -- --version
bun run build
./dist/deputydev2 --version
```

Local development reads `DEPUTYDEV_SERVICE_ORIGIN` from the ignored `.env`. Copy `.env.example` when setting up a new checkout. Compiled release binaries receive a validated service origin at build time and do not autoload project environment files.
