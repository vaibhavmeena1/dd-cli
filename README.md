# DeputyDev CLI

Native Bun/TypeScript launcher for running supported coding harnesses with DeputyDev-managed configuration and resources. The command is `ddcli`; existing persistent state and environment-variable names continue to use the stable `deputydev`/`DEPUTYDEV_*` identity.

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
- Verified, atomic installer for the native Apple Silicon binary
- Tag-validated GitHub Release workflow with dual hashes, metadata, and GitHub provenance

### Deferred

- Phase 0 compatibility evidence and the complete Phase 0.5 PTY/import-boundary suite
- Pi auth import and onboarding
- OpenCode profile isolation, standalone policy, resources, and provisioning
- Apple Developer ID signing and notarization
- Signed update manifests and updater behavior

## Installation

The initial `0.1.x` releases support Apple Silicon macOS only. The launcher does not bundle Pi or OpenCode; install at least one supported harness separately.

Once the production website serves the repository's unchanged [`install.sh`](install.sh), install with:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://YOUR_ORIGIN/install.sh | sh
```

For an inspect-first installation:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo install.sh https://YOUR_ORIGIN/install.sh
less install.sh
sh install.sh
```

The installer uses no `sudo`, installs to `${DEPUTYDEV_HOME:-$HOME/.deputydev}/bin/ddcli`, verifies compressed and decompressed SHA-256 hashes, verifies the ad-hoc code signature and exact version, preserves an existing binary as `ddcli.prev`, and atomically activates the replacement. Follow its printed PATH instruction, then run:

```bash
ddcli doctor
```

> **macOS trust limitation:** the MVP binary is explicitly ad-hoc signed, not Apple Developer ID signed or notarized. The verified terminal installer does not disable Gatekeeper. A browser-downloaded copy may receive a quarantine attribute and trigger an unidentified-developer warning. After independently checking its published checksum and signature, remove only that file's quarantine attribute if necessary: `xattr -d com.apple.quarantine ~/.deputydev/bin/ddcli`. Never disable Gatekeeper globally.

Users who require GitHub provenance verification can download the archive and run:

```bash
gh attestation verify ddcli-darwin-arm64.gz --repo vaibhavmeena1/dd-cli
```

## Usage

```bash
ddcli pi [pi arguments...]
ddcli opencode [opencode arguments...]
ddcli opencode2 [opencode arguments...] # compatibility alias
```

Everything after the harness token bypasses Commander and retains its token order. For example, `ddcli pi --help` launches `pi --help`. Ordinary Pi sessions are prefixed with explicit DeputyDev-owned resource flags; Pi help/version and package administration commands remain unchanged.

Launcher-owned commands:

```bash
ddcli harnesses
ddcli paths
ddcli doctor [pi|opencode|opencode2]
ddcli setup pi --sync-packages
ddcli uninstall [--remove-runtimes] [--remove-profiles]
```

`uninstall` only mutates an installation when the running executable is the managed binary at `~/.deputydev/bin/ddcli`. The dedicated Pi directory is preserved. OpenCode profiles and cached runtimes are also preserved unless their explicit removal flags are supplied.

Set `DEPUTYDEV_DEBUG=1` for a redacted launch preview on stderr. Harness executable overrides are `DEPUTYDEV_PI_BIN` and `DEPUTYDEV_OPENCODE_BIN`.

### Pi data isolation

Every `ddcli pi` launch sets:

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

Minimum and floating entries remain eligible for native `ddcli pi update --extensions`. DeputyDev does not query registries or schedule updates for healthy minimum/floating packages. It only installs a missing package, repairs a below-minimum package, or restores the required unfiltered settings entry. Exact versions change only with a new embedded DeputyDev manifest.

A first ordinary interactive launch installs missing required packages with visible progress. Print, JSON/RPC, piped, CI, and other non-interactive launches perform no package installation network work and instead direct the user to:

```bash
ddcli setup pi --sync-packages
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
./dist/ddcli --version
```

Local development reads `DEPUTYDEV_SERVICE_ORIGIN` from the ignored `.env`. Copy `.env.example` when setting up a new checkout. Compiled release binaries receive a validated service origin at build time and do not autoload project environment files.

## Releasing

Releases use plain canonical semantic versions without a `v` prefix. `package.json`, the Git tag, the GitHub Release title, and `ddcli --version` must match exactly. For the first stable release they are all `0.1.0`.

1. Create a GitHub Environment named `production`.
2. Add the non-secret environment variable `DEPUTYDEV_SERVICE_ORIGIN`. It must be an HTTPS origin only, with no credentials, path, query, fragment, or trailing slash.
3. Update `package.json`, merge to `main` with green CI, and create a GitHub **pre-release** whose tag and title both equal the package version.
4. The release workflow checks out the exact tag, verifies it belongs to `main`, reruns all checks, builds and ad-hoc signs `darwin-arm64`, uploads assets without clobbering, creates provenance, and promotes stable SemVer versions only after success. SemVer prereleases such as `0.1.0-rc.1` remain GitHub pre-releases.

A failed pre-release can be retried with the workflow's manual dispatch. Existing assets still fail by default; `replace_assets` is an explicit recovery-only option.

Each release contains:

```text
ddcli-darwin-arm64.gz
ddcli-darwin-arm64.map
checksums.txt
release-metadata.json
VERSION
install.sh
```

The production website/static origin must serve the same `install.sh` at `/install.sh` and a direct `application/json` MCP catalog at `/v1/cli/pi/mcp.json`. An initial catalog may be `{ "mcpServers": {} }`. No dynamic backend or database is required for binary distribution.
