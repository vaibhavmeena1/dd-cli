# DeputyDev CLI

This app lives at `apps/cli` inside the DeputyDev monorepo. Workspace-wide setup is described in the [root README](../../README.md).

Native Bun/TypeScript launcher for running supported coding harnesses with DeputyDev-managed configuration and resources. The command is `ddcli`; existing persistent state and environment-variable names continue to use the stable `deputydev`/`DEPUTYDEV_*` identity.

## Current status

**Launcher Phase 1, Pi resource/package isolation, and OpenCode installation plus extension provisioning are implemented.** The CLI resolves and starts Pi and OpenCode while preserving user-supplied harness arguments. `ddcli opencode2` uses an existing executable when available and otherwise runs OpenCode's official installer with a DeputyDev-selected exact version. OpenCode sessions receive manifested plugins through generated inline config; reusable sessions use a health-checked DeputyDev service with isolated state and an ephemeral loopback port. Normal OpenCode auth, config, data, and cache remain shared.

### Implemented

- Bun 1.4.1, strict TypeScript, Biome, and native `darwin-arm64` compilation
- Product identity, build metadata, service-origin validation, and managed paths
- Pre-Commander dispatch for `pi`, `opencode`, and the `opencode2` alias
- Locked, first-use OpenCode installation through `https://opencode.ai/v2/install`, always with an explicit DeputyDev-controlled version and no shell PATH-file modification
- Content-keyed OpenCode plugin provisioning through merged `OPENCODE_CONFIG_CONTENT`, with standalone/hosted mode support and a dedicated reusable service that cannot collide with normal OpenCode service state or its fixed port
- Pi-only setup checks, including append-only organization MCP defaults at `~/.config/mcp/mcp.json`, requested only for interactive online launches and throttled locally
- Pi agent/session isolation under `${DEPUTYDEV_HOME}/pi`, with Pi version checks disabled and every Pi-documented provider API key removed from Pi only (LiteLLM variables are kept)
- Pi version gate: an existing Pi at or above the supported minimum is used; otherwise DeputyDev installs the exact pinned Pi release under `${DEPUTYDEV_HOME}/pi-runtime` from Pi's release API with `npm ci`, with the probed version cached per executable
- Content-addressed, checksum-verified DeputyDev Pi resources injected through explicit Pi flags that reference the immutable runtime directory
- Embedded required-package policy with exact, minimum, and Pi/user-managed floating versions
- Locked package reconciliation, last-known-good exact fallback, and local-only warm checks
- Executable overrides and PATH resolution without shell evaluation
- Preserved user harness arguments and inherited stdio/cwd; adapters may add required generated resource or local-service options
- DeputyDev control-variable stripping and redacted debug launch previews
- Child exit-code and signal-status propagation
- `harnesses`, `paths`, basic `doctor`, and guarded `uninstall` commands
- Launcher-core tests for registry behavior, environment isolation, argv passthrough, aliases, and reserved exit statuses
- Verified, atomic installer for the native Apple Silicon binary
- Tag-validated GitHub Release workflow with dual hashes, metadata, and GitHub provenance

### Deferred

- Phase 0 compatibility evidence and the complete Phase 0.5 PTY/import-boundary suite
- Pi auth import and onboarding
- Full OpenCode config/auth/data/cache profile isolation and auth onboarding
- Apple Developer ID signing and notarization
- Signed update manifests and updater behavior

## Installation

The initial `0.1.x` releases support Apple Silicon macOS only. The launcher bundles neither harness. `ddcli pi` uses an existing Pi at or above the supported minimum version and otherwise installs the pinned Pi release itself (this needs Node.js 22.19 or newer and npm). OpenCode may be installed separately, or `ddcli opencode2` will bootstrap the configured OpenCode version on first use.

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

Everything after the harness token bypasses Commander and retains its relative token order. For example, `ddcli pi --help` launches `pi --help`. Ordinary Pi sessions are prefixed with explicit DeputyDev-owned resource flags; reusable OpenCode sessions receive a generated local `--server` option. Administrative and remote OpenCode commands receive no plugin injection.

Launcher-owned commands:

```bash
ddcli harnesses
ddcli paths
ddcli doctor [pi|opencode|opencode2]
ddcli setup pi --sync-packages   # installs Pi if needed, required packages, resources, and MCP defaults
ddcli uninstall [--remove-runtimes] [--remove-profiles]
```

`uninstall` only mutates an installation when the running executable is the managed binary at `~/.deputydev/bin/ddcli`. The dedicated Pi directory is preserved. OpenCode profiles and cached runtimes are also preserved unless their explicit removal flags are supplied.

Set `DEPUTYDEV_DEBUG=1` for a redacted launch preview on stderr. Harness executable overrides are `DEPUTYDEV_PI_BIN` and `DEPUTYDEV_OPENCODE_BIN`.

### OpenCode installation bootstrap

`ddcli opencode` and `ddcli opencode2` first resolve the user-provided override and normal `PATH` candidates (`opencode2`, then `opencode`). If neither executable exists, the OpenCode adapter:

1. acquires `${DEPUTYDEV_HOME}/locks/opencode-install.lock` and checks again
2. downloads `https://opencode.ai/v2/install` in the DeputyDev process
3. runs the downloaded script with Bash as `--version <exact-version> --no-modify-path`
4. checks both the inherited `PATH` and OpenCode's standard `~/.opencode/bin` directory
5. launches the resulting executable with the original user arguments

The pinned default currently lives as `DEFAULT_OPENCODE_VERSION` in [`src/harnesses/opencode/installation.ts`](src/harnesses/opencode/installation.ts). It should be reviewed and changed through a DeputyDev release. `DEPUTYDEV_OPENCODE_VERSION` provides an operational exact-version override; it is consumed only by the installer and is stripped before OpenCode starts. An invalid `DEPUTYDEV_OPENCODE_BIN` remains an error and never triggers a surprise installation.

### OpenCode extensions and service isolation

OpenCode V2 has no Pi-style one-launch extension flag. For default TUI, `run`, `mini`, user-requested `--standalone`, `acp`, and `serve` launches, DeputyDev materializes bundled plugin directories under `${DEPUTYDEV_HOME}/runtime/opencode-<version>-<hash>` and merges their absolute paths plus manifested package plugins into `OPENCODE_CONFIG_CONTENT`. Existing valid JSON/JSONC inline settings are retained; malformed inline config fails with remediation instead of being discarded. User OpenCode config and project files are never rewritten.

Default TUI, `run`, and `mini` reuse a service whose XDG state root is `${DEPUTYDEV_HOME}/opencode-state`. DeputyDev starts that service on an ephemeral loopback port, health-checks it, fingerprints the exact generated inline config, and routes the client to its authenticated URL. This preserves normal OpenCode auth/config/data/cache while preventing a direct `opencode2` service—including one using the fixed default port—from being restarted or modified. Standalone launches, `acp`, and `serve` receive plugins without service reconciliation. Explicit `--server`, administrative, help/version, and unknown invocations receive no DeputyDev plugins.

See [`docs/plans/opencode2-integration.md`](docs/plans/opencode2-integration.md) for the implementation record and remaining profile/auth/version work.

### Pi installation bootstrap

`ddcli pi` resolves the Pi executable in this order:

1. `DEPUTYDEV_PI_BIN`, which is authoritative. A version below the supported minimum only produces a warning.
2. `pi` on `PATH` when its version is at least `PI_MINIMUM_VERSION` (or cannot be determined). Forwarded Pi administration such as `ddcli pi update` always uses this executable.
3. The DeputyDev-managed install at `${DEPUTYDEV_HOME}/pi-runtime/<version>/node_modules/.bin/pi`, created on demand when Pi is missing or too old.

The official `https://pi.dev/install.sh` cannot pin a version, requires an interactive terminal, and may edit shell profiles, so DeputyDev does not run it. Instead it follows the same steps as Pi's own managed `pi update`: it downloads `package.json` and `package-lock.json` for the exact version from `https://pi.dev/api/installer/releases/<version>/`, plus the release metadata from `https://pi.dev/api/installer/releases/<version>`, validates that all three describe `@earendil-works/pi-coding-agent@<version>`, merges the first-party tarball SHA-512 hashes from the metadata into the lockfile (the published lockfile omits them) so that every resolved tarball is integrity-checked, runs `npm ci --ignore-scripts --omit=dev --include=optional` in a staging directory under a same-user lock, verifies the installed package version and launcher, and atomically renames the tree into place. Shell profiles and `PATH` are never modified.

Installation requires Node.js 22.19.0 or newer and npm on `PATH`; otherwise the launch fails with a remediation that names Homebrew and the official installer. Offline launches (`--offline` or `PI_OFFLINE=1`) and `ddcli doctor` never install. The pinned versions live in [`src/harnesses/pi/installation.ts`](src/harnesses/pi/installation.ts) as `PI_MINIMUM_VERSION` and `PI_INSTALL_VERSION`; `DEPUTYDEV_PI_VERSION` is an operational exact-version override consumed only by the installer and stripped before Pi starts. `pi --version` results are cached per executable path, size, and mtime in `${DEPUTYDEV_HOME}/pi-executable.json`, so warm launches do not spawn Pi twice. `ddcli uninstall --remove-runtimes` also removes `pi-runtime`.

### Pi data isolation

Every `ddcli pi` launch sets:

```text
PI_CODING_AGENT_DIR=${DEPUTYDEV_HOME}/pi
PI_CODING_AGENT_SESSION_DIR=${DEPUTYDEV_HOME}/pi/sessions
```

With the default DeputyDev home, these resolve to `~/.deputydev/pi` and `~/.deputydev/pi/sessions`. Pi settings, auth, installed npm/git packages, temporary package caches, and sessions used through DeputyDev therefore remain separate from the user's normal `~/.pi/agent` directory. The values override inherited `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` settings, including for forwarded Pi package commands.

Pi launches set `PI_SKIP_VERSION_CHECK=1` to disable Pi's startup version request. They also remove every provider API-key variable documented by Pi (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, and the rest of the list exported as `PI_STRIPPED_PROVIDER_VARIABLES` in [`src/harnesses/pi/environment.ts`](src/harnesses/pi/environment.ts)) so ambient personal credentials never select a provider implicitly. `LITELLM_*` variables, `GOOGLE_APPLICATION_CREDENTIALS`, cloud SDK configuration, and proxy variables are kept because the pinned `pi-provider-litellm` package is the organization provider path. These provider-key policies are Pi-specific; OpenCode retains inherited provider credentials. Its adapter overrides only generated inline plugin config, the isolated state root, and dedicated-service authentication without mutating `process.env`.

### Pi resources and required packages

DeputyDev-owned extensions, skills, prompts, and themes are embedded in the CLI, materialized under `${DEPUTYDEV_HOME}/runtime/<version>-<hash>/pi`, and checksum-verified. Ordinary Pi sessions receive explicit resource arguments that reference that immutable directory, so a concurrently running launcher of another DeputyDev version can never swap resources underneath a session. The `runtime/current` symlink is maintained for inspection only. The core extension provides `/deputydev-status`. Resource source has an independent Pi extension typecheck.

Every non-administrative `ddcli pi` session also loads the embedded `pi-org-telemetry` extension. Its OpenTelemetry dependencies are bundled into one standalone ESM resource at DeputyDev build time, so `--extension <immutable-path>` does **not** run `npm install`, execute dependency lifecycle scripts, contact a package registry, or download dependencies. A new DeputyDev release materializes a new content-addressed bundle once; healthy launches verify and reuse it.

The telemetry extension stays inert without managed OTLP configuration. To export traces, metrics, and structured logs, provide `OTEL_EXPORTER_OTLP_ENDPOINT` (or all three per-signal endpoint variables) in the environment used to start `ddcli`. HTTP/protobuf and gRPC are supported. Export failures are passive and bounded, and `PI_ORG_OTEL_ENABLED=false` is the emergency kill switch. The extension never exports prompt/completion text, system prompts, file contents, tool results, provider payloads, authorization headers, environment values, full session paths, raw Git remotes, or stack traces. It does export raw effective Git email when available, an installation UUID fallback, and the normalized private repository slug; collector access and retention must be restricted accordingly. See [`src/harnesses/pi/telemetry/README.md`](src/harnesses/pi/telemetry/README.md), its [data policy](src/harnesses/pi/telemetry/docs/data-policy.md), and its [schema](src/harnesses/pi/telemetry/docs/telemetry-schema.md).

The embedded manifest in `src/product/manifest.ts` declares required community packages. It currently locks `pi-mcp-adapter` to `2.34.0` and `pi-provider-litellm` to `3.0.1`, while `@juicesharp/rpiv-ask-user-question` remains floating so Pi or the user can upgrade it. Package entries support:

- `exact`: only the declared version is accepted; a failed migration may use a verified, non-revoked last-known-good exact version
- `minimum`: the declared version is a hard floor; newer installed versions are accepted and never downgraded
- `floating`: no DeputyDev version constraint; Pi or the user may update it at any time

Minimum and floating entries remain eligible for native `ddcli pi update --extensions`. DeputyDev does not query registries or schedule updates for healthy minimum/floating packages. It only installs a missing package, repairs a below-minimum package, or restores the required unfiltered settings entry. Exact versions change only with a new embedded DeputyDev manifest.

A first ordinary interactive launch installs missing required packages with visible progress. Print, JSON/RPC, piped, CI, offline (`--offline` or `PI_OFFLINE=1`), and other non-interactive launches perform no package installation network work and instead direct the user to:

```bash
ddcli setup pi --sync-packages
```

Package checks inspect `${DEPUTYDEV_HOME}/pi/settings.json` and installed package metadata directly; they do not parse `pi list`. State is written to `${DEPUTYDEV_HOME}/pi-packages.json`, synchronization uses a same-user lock, and unrelated user package entries are preserved. If a later manifest removes a package, DeputyDev removes it only when state and unchanged metadata prove it is still DeputyDev-owned.

> **Security:** Pi packages run with full user permissions. Extensions, skills, dependency install scripts, and update commands can execute code. Treat every required package and manifest change as release-grade code.

See [`docs/plans/pi-package-provisioning.md`](docs/plans/pi-package-provisioning.md) for the manifest schema, lifecycle decisions, and verification plan.

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

The request is best-effort and capped at 700 ms. It runs only for ordinary interactive, online launches; print, JSON/RPC, piped, CI, and offline sessions never wait on it. Attempts are recorded in `${DEPUTYDEV_HOME}/pi-mcp-sync.json`: after a successful request the catalog is not requested again for six hours, and after a failed one for fifteen minutes. `ddcli setup pi --sync-packages` ignores that throttle. If the catalog is unavailable on first run, DeputyDev creates a safe empty `mcpServers` scaffold and retries later. Setup failures never prevent Pi from starting; details are shown with `DEPUTYDEV_DEBUG=1`.

## Development

Bun must be available in your shell. The repository pins Bun `1.4.1`. Dependencies are installed once at the monorepo root; everything else runs from this directory.

```bash
bun install --frozen-lockfile   # at the repository root
cd apps/cli
bun run check                   # telemetry bundle check and typecheck
bun test
bun run dev -- --version
bun run build
./dist/ddcli --version
```

Formatting and lint run from the repository root with `biome ci .`, which the root `bun run check` includes.

Local development reads `DEPUTYDEV_SERVICE_ORIGIN` from the ignored `apps/cli/.env`. Copy `.env.example` in this directory when setting up a new checkout. Compiled release binaries receive a validated service origin at build time and do not autoload project environment files.

Every package this app imports must be declared in `apps/cli/package.json`. Bun uses isolated installs in the workspace, so a transitive dependency of another package is not resolvable from here.

## Releasing

GitHub Releases are shared by every component in the monorepo, so CLI release tags are namespaced as `cli-<version>`. The version is a plain canonical semantic version without a `v` prefix. `apps/cli/package.json`, the version inside the tag, the `VERSION` asset, and `ddcli --version` must match exactly, and the GitHub Release title must equal the tag. For example, package version `0.2.0` is released from tag and title `cli-0.2.0`.

1. Create a GitHub Environment named `production`.
2. Add the non-secret environment variable `DEPUTYDEV_SERVICE_ORIGIN`. It must be an HTTPS origin only, with no credentials, path, query, fragment, or trailing slash.
3. Update `apps/cli/package.json`, merge to `main` with green CI, and create a GitHub **pre-release** whose tag and title are both `cli-<package version>`.
4. The release workflow runs only for tags starting with `cli-`. It checks out the exact tag, verifies it belongs to `main`, reruns all checks from `apps/cli`, builds and ad-hoc signs `darwin-arm64`, uploads assets without clobbering, creates provenance, and promotes stable SemVer versions only after success. SemVer prereleases such as `cli-0.1.0-rc.1` remain GitHub pre-releases.

A failed pre-release can be retried with the workflow's manual dispatch by passing the existing tag as `release_tag`. Existing assets still fail by default; `replace_assets` is an explicit recovery-only option.

The installer downloads `VERSION` from the release marked **latest** and then fetches assets from `releases/download/cli-<version>/`. Only CLI releases may therefore be marked latest; a backend or frontend release marked latest would make `install.sh` fail with a missing `VERSION` asset.

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
