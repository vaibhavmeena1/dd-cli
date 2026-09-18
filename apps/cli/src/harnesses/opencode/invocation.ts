/** OpenCode V2 launch modes relevant to DeputyDev extension injection. */
export type OpenCodeInvocationMode =
  | "shared-session"
  | "private-session"
  | "hosted-server"
  | "passthrough";

const SESSION_SUBCOMMANDS: ReadonlySet<string> = new Set(["run", "mini"]);
const PRIVATE_SUBCOMMANDS: ReadonlySet<string> = new Set(["acp"]);
const HOSTED_SERVER_SUBCOMMANDS: ReadonlySet<string> = new Set(["serve"]);
const ADMINISTRATIVE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "upgrade",
  "update",
  "api",
  "debug",
  "console",
  "auth",
  "mcp",
  "plugin",
  "models",
  "stats",
  "export",
  "import",
  "service",
  "pair",
]);
const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  ...SESSION_SUBCOMMANDS,
  ...PRIVATE_SUBCOMMANDS,
  ...HOSTED_SERVER_SUBCOMMANDS,
  ...ADMINISTRATIVE_SUBCOMMANDS,
]);

/** Root options whose following token is a value rather than a subcommand. */
const ROOT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--server",
  "--session",
  "-s",
  "--prompt",
]);

export interface OpenCodeInvocation {
  readonly mode: OpenCodeInvocationMode;
  readonly enablesExtensions: boolean;
  readonly reconcilesService: boolean;
  readonly command?: string;
  readonly commandIndex?: number;
}

interface ParsedRoot {
  readonly command?: string;
  readonly commandIndex?: number;
  readonly hasUnknownPositional: boolean;
  readonly standalone: boolean;
  readonly server: boolean;
  readonly informational: boolean;
}

function argumentsBeforeTerminator(userArguments: readonly string[]): readonly string[] {
  const terminator = userArguments.indexOf("--");
  return terminator === -1 ? userArguments : userArguments.slice(0, terminator);
}

function parseRoot(userArguments: readonly string[]): ParsedRoot {
  const argumentsVector = argumentsBeforeTerminator(userArguments);
  let command: string | undefined;
  let commandIndex: number | undefined;
  let hasUnknownPositional = false;
  const standalone = argumentsVector.includes("--standalone");
  const server = argumentsVector.some(
    (argument) => argument === "--server" || argument.startsWith("--server="),
  );
  const informational = argumentsVector.some((argument) =>
    ["--help", "-h", "--version", "-V"].includes(argument),
  );

  for (let index = 0; index < argumentsVector.length; index += 1) {
    const argument = argumentsVector[index] as string;
    if (argument === "--server" || ROOT_VALUE_OPTIONS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      continue;
    }
    if (KNOWN_SUBCOMMANDS.has(argument)) {
      command = argument;
      commandIndex = index;
    } else {
      hasUnknownPositional = true;
    }
    break;
  }

  return {
    ...(command === undefined ? {} : { command }),
    ...(commandIndex === undefined ? {} : { commandIndex }),
    hasUnknownPositional,
    standalone,
    server,
    informational,
  };
}

/**
 * Classify without rewriting user arguments.
 *
 * - Root TUI, `run`, and `mini` use DeputyDev's dedicated reusable service.
 * - User-requested standalone launches and `acp` host private servers.
 * - `serve` hosts a foreground server.
 * - Explicit remote servers, administration, help, and unknown future commands
 *   pass through without DeputyDev plugins.
 */
export function classifyOpenCodeInvocation(userArguments: readonly string[]): OpenCodeInvocation {
  const parsed = parseRoot(userArguments);
  const metadata = {
    ...(parsed.command === undefined ? {} : { command: parsed.command }),
    ...(parsed.commandIndex === undefined ? {} : { commandIndex: parsed.commandIndex }),
  };

  if (parsed.informational || parsed.server || parsed.hasUnknownPositional) {
    return { mode: "passthrough", enablesExtensions: false, reconcilesService: false, ...metadata };
  }
  if (parsed.command !== undefined && ADMINISTRATIVE_SUBCOMMANDS.has(parsed.command)) {
    return { mode: "passthrough", enablesExtensions: false, reconcilesService: false, ...metadata };
  }
  if (parsed.command !== undefined && HOSTED_SERVER_SUBCOMMANDS.has(parsed.command)) {
    return {
      mode: "hosted-server",
      enablesExtensions: true,
      reconcilesService: false,
      ...metadata,
    };
  }
  if (
    parsed.standalone ||
    (parsed.command !== undefined && PRIVATE_SUBCOMMANDS.has(parsed.command))
  ) {
    return {
      mode: "private-session",
      enablesExtensions: true,
      reconcilesService: false,
      ...metadata,
    };
  }
  if (parsed.command === undefined || SESSION_SUBCOMMANDS.has(parsed.command)) {
    return {
      mode: "shared-session",
      enablesExtensions: true,
      reconcilesService: true,
      ...metadata,
    };
  }
  return { mode: "passthrough", enablesExtensions: false, reconcilesService: false, ...metadata };
}

/** Route a shared session to the already-reconciled DeputyDev service. */
export function withOpenCodeServer(
  invocation: OpenCodeInvocation,
  userArguments: readonly string[],
  url: string,
): readonly string[] {
  if (!invocation.reconcilesService) {
    return [...userArguments];
  }
  const serverArgument = `--server=${url}`;
  if (invocation.commandIndex === undefined) {
    return [serverArgument, ...userArguments];
  }
  const result = [...userArguments];
  result.splice(invocation.commandIndex + 1, 0, serverArgument);
  return result;
}
