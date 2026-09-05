export type PiInvocationKind = "administrative" | "interactive" | "noninteractive";

export interface PiInvocationEnvironment {
  readonly ci: boolean;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
}

const ADMINISTRATIVE_COMMANDS = new Set([
  "config",
  "install",
  "list",
  "remove",
  "uninstall",
  "update",
]);
const ADMINISTRATIVE_FLAGS = new Set(["--help", "-h", "--version", "-v"]);
const NONINTERACTIVE_FLAGS = new Set(["--print", "-p", "--export"]);

export function currentPiInvocationEnvironment(): PiInvocationEnvironment {
  const ciValue = (Reflect.get(process.env, "CI") as string | undefined)?.toLowerCase();
  return {
    ci: ciValue === "1" || ciValue === "true" || ciValue === "yes",
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
  };
}

export function classifyPiInvocation(
  argumentsVector: readonly string[],
  environment: PiInvocationEnvironment = currentPiInvocationEnvironment(),
): PiInvocationKind {
  const first = argumentsVector[0];
  if (
    (first !== undefined && ADMINISTRATIVE_COMMANDS.has(first)) ||
    argumentsVector.some((argument) => ADMINISTRATIVE_FLAGS.has(argument))
  ) {
    return "administrative";
  }

  const modeIndex = argumentsVector.indexOf("--mode");
  const mode = modeIndex === -1 ? undefined : argumentsVector[modeIndex + 1];
  if (
    environment.ci ||
    !environment.stdinIsTty ||
    !environment.stdoutIsTty ||
    mode === "json" ||
    mode === "rpc" ||
    argumentsVector.some((argument) => NONINTERACTIVE_FLAGS.has(argument))
  ) {
    return "noninteractive";
  }

  return "interactive";
}
