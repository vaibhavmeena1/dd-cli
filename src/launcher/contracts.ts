import type { DeputyDevPaths } from "../product/paths.ts";

export type StableHarnessId = "pi" | "opencode";

export interface LaunchContext {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly paths: DeputyDevPaths;
}

export interface HarnessLaunchContext extends LaunchContext {
  readonly registration: HarnessRegistration;
  readonly executable: string;
}

export interface LaunchSpec {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export interface DoctorFinding {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly remediation?: string;
}

export interface HarnessAdapter {
  readonly id: StableHarnessId;
  prepare(context: HarnessLaunchContext, userArguments: readonly string[]): Promise<void>;
  buildLaunchSpec(
    context: HarnessLaunchContext,
    userArguments: readonly string[],
  ): Promise<LaunchSpec>;
  doctor(context: LaunchContext): Promise<readonly DoctorFinding[]>;
}

export interface HarnessRegistration {
  readonly id: StableHarnessId;
  readonly aliases: readonly string[];
  readonly executableCandidates: readonly string[];
  readonly executableOverrideVariable: string;
}
