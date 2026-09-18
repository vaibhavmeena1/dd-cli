import type { LauncherExitStatus } from "./exit-status.ts";

export class LauncherError extends Error {
  readonly exitStatus: LauncherExitStatus;
  readonly remediation: string | undefined;

  constructor(
    message: string,
    exitStatus: LauncherExitStatus,
    options: { readonly cause?: unknown; readonly remediation?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LauncherError";
    this.exitStatus = exitStatus;
    this.remediation = options.remediation;
  }
}
