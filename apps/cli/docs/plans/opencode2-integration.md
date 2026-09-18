# OpenCode 2 (`opencode2`) integration

## Status

**Phase 1 — installation bootstrap: implemented.**  
**Phase 2 — bundled extension injection and isolated service lifecycle: implemented.**

This document records exactly what DeputyDev currently does for OpenCode and what remains. The stable internal harness ID remains `opencode`; `opencode2` is a user-facing compatibility alias.

## Implemented scope

A user can run either command:

```bash
ddcli opencode [arguments...]
ddcli opencode2 [arguments...]
```

DeputyDev preserves all user-supplied argument tokens after the harness name. Shared sessions additionally receive one generated `--server=<url>` option. Before launch it resolves the executable in this order:

1. `DEPUTYDEV_OPENCODE_BIN`, when explicitly set
2. `opencode` on the inherited `PATH`
3. `opencode2` on the inherited `PATH`
4. after locking, the same candidates with `~/.opencode/bin` prepended to the lookup path
5. if still absent, installation followed by one final lookup

An invalid explicit binary override fails with launcher status `121`; it is never bypassed by an automatic installation.

### Extension behavior

OpenCode V2 has no Pi-style `-e` extension argument. DeputyDev enables its manifested extensions through a generated `OPENCODE_CONFIG_CONTENT` value:

1. bundled plugin files are hash-verified and materialized under a content-keyed directory in `${DEPUTYDEV_HOME}/runtime`
2. bundled plugin directories are added as absolute paths
3. vetted public plugins from the product manifest are added as policy-pinned package specifiers
4. valid inherited JSON/JSONC config is preserved and merged; malformed inherited config fails with direct remediation
5. no user `opencode.json(c)` file or project file is written

The launch policy is mode-aware:

| Invocation | DeputyDev plugins | Reusable service reconciliation |
|---|---:|---:|
| Default TUI, `run`, `mini` | yes | yes |
| User-supplied `--standalone` | yes | no |
| `acp` (always private upstream) | yes | no |
| `serve` | yes | no |
| Explicit `--server` | no | no |
| Administrative, informational, or unknown command | no | no |

Reusable sessions use a DeputyDev-owned `XDG_STATE_HOME` under `${DEPUTYDEV_HOME}`. Normal OpenCode config, authentication, data, and cache roots remain inherited. DeputyDev starts its service directly on an ephemeral loopback port, records its health-checked registration and generated-config fingerprint, and routes the client with `--server=<url>` plus the registered password. This prevents collisions with or restarts of the user's normal OpenCode service, including its fixed default port.

A missing, unhealthy, or differently fingerprinted DeputyDev service is replaced under a file lock. If the required environment cannot be established, launch fails rather than silently running without DeputyDev extensions.

### Installation behavior

When no executable can be resolved, `src/harnesses/opencode/installation.ts`:

1. acquires `${DEPUTYDEV_HOME}/locks/opencode-install.lock`
2. checks again after acquiring the lock, preventing duplicate concurrent installs
3. downloads `https://opencode.ai/v2/install` with a 30-second request timeout
4. rejects a non-successful or empty response
5. starts Bash directly—without a shell command string—and sends the script over stdin
6. invokes the installer with:

   ```text
   --version <DeputyDev-selected-version> --no-modify-path
   ```

7. requires a resolvable `opencode` or `opencode2` executable after installation
8. launches OpenCode through the mode-specific adapter path with inherited stdio/cwd and preserved user arguments

The installer output remains visible. Installation and lookup failures use actionable launcher errors. The downloaded script is not written to the project directory.

### Version ownership

DeputyDev never asks the upstream installer for the moving beta channel implicitly. It always supplies an exact version.

The release-controlled default is:

```ts
DEFAULT_OPENCODE_VERSION = "0.0.0-beta-19086"
```

in `src/harnesses/opencode/installation.ts`.

To change the standard version, update that constant, run the tests, and release a new DeputyDev binary. Operators can temporarily select another exact version with:

```bash
DEPUTYDEV_OPENCODE_VERSION=0.0.0-beta-XXXXX ddcli opencode2
```

The override must be canonical semantic version text without a leading `v`; moving channels such as `latest` and unsafe shell-like strings are rejected. It and all other `DEPUTYDEV_*` installer controls are removed from the OpenCode child environment.

> The override is intentionally an operational escape hatch. A future signed/server-managed harness manifest can replace it as the normal remote-control mechanism, but that has not been implemented in this phase.

## Code changes

| Path | Responsibility |
|---|---|
| `src/harnesses/opencode/installation.ts` | Detect, lock, download, invoke the official installer, and resolve the installed executable |
| `src/harnesses/opencode/adapter.ts` | Resolve/install OpenCode, classify launches, provision extensions, reconcile the dedicated service, and build mode-specific launch specs |
| `src/harnesses/opencode/extensions/config.ts` | Merge inline JSONC config, inject plugin entries, isolate XDG state, and hash the generated config |
| `src/harnesses/opencode/extensions/provision.ts` | Hash-verify and atomically materialize bundled plugins into immutable runtime directories |
| `src/harnesses/opencode/invocation.ts` | Classify shared, private, hosted, remote, administrative, and informational invocations |
| `src/harnesses/opencode/service.ts` | Health-check, fingerprint, start, stop, and replace the ephemeral-port DeputyDev service |
| `src/harnesses/opencode/resources/plugins/deputydev-core/index.mjs` | Bundled dependency-free OpenCode plugin entrypoint |
| `src/launcher/contracts.ts` | Optional adapter-level `resolveExecutable` hook |
| `src/launcher/launch-harness.ts` | Resolve through the adapter before preparation/build/spawn |
| `src/launcher/environment.ts` | Register and strip `DEPUTYDEV_OPENCODE_VERSION` |
| `tests/opencode-installation.test.ts` | Version policy, warm path, install path, override safety, and failure coverage |

## Security and operational choices

- Existing user installations win; no network request is made on the warm path.
- The upstream response is fetched as data and passed to a fixed Bash executable. No URL, version, or user argument is interpolated into a shell command string.
- `--no-modify-path` prevents the upstream installer from editing `.zshrc`, `.bashrc`, or similar shell configuration through an automatic `ddcli` launch.
- The version argument is constrained before it reaches the installer.
- The install, materialization, and service lifecycle locks are in the DeputyDev lock directory and use the existing stale-lock recovery implementation.
- OpenCode service state and registration are isolated; user config/auth/data/cache and project discovery remain available.
- The dedicated service binds only to loopback on an ephemeral port and uses OpenCode's generated registration password.
- The service fingerprint includes the exact generated inline config, not only the bundled-resource hash.
- DeputyDev currently relies on HTTPS transport and the upstream installer's npm/package checks. Pinning or vendoring the installer bytes and signature verification are not part of this phase.

## Tests implemented

The test suite verifies:

- the DeputyDev-controlled default version
- an exact environment override
- rejection of unsafe version strings
- no fetch when a user executable already exists
- official URL selection
- propagation of script bytes and selected version to the installer runner
- discovery in `~/.opencode/bin` after installation
- explicit override precedence and failure behavior
- clear failure when installation creates no executable
- existing launcher alias, argv, environment, and child-exit propagation behavior
- JSONC inline-config preservation, deduplication, and malformed-config failures
- shared/private/hosted/remote/administrative invocation classification
- content-keyed bundled-plugin materialization
- isolated state-root selection
- service pre-warm, healthy reuse, config mismatch replacement, and fail-closed behavior
- adapter routing to the authenticated dedicated endpoint

The pinned `0.0.0-beta-19086` binary was also smoke-tested manually: the isolated service registered on an ephemeral loopback port while the normal fixed port remained untouched, and an injected fixture plugin activated through the service API.

## Deliberately deferred to the next phase

These phases do not claim full OpenCode product integration. The following remain open:

- fully isolated OpenCode config/data/cache/auth profile (only state/service is isolated today)
- auth detection, explicit import, and managed login
- product functionality beyond the bundled no-op core plugin
- compatibility/version probing and caching
- garbage collection or rollback policy for superseded content-keyed plugin runtimes
- upgrade/downgrade reconciliation when an executable is already present
- signed remote version policy
- uninstalling OpenCode installed by this bootstrap
- Windows-specific `.cmd` executable resolution

## Next-phase checklist

1. Replace the no-op core plugin with reviewed DeputyDev OpenCode functionality.
2. Add explicit auth onboarding without exposing token contents.
3. Probe and cache the running service/client version before explicit endpoint routing.
4. Decide how server-controlled exact versions are authenticated and cached.
5. Define upgrade ownership and behavior for user-installed versus DeputyDev-installed OpenCode.
6. Add runtime garbage collection after proving no active service references an older directory.
7. Add release CI coverage against the pinned OpenCode binary in addition to unit tests.
