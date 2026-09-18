export const LAUNCHER_EXIT_STATUS = Object.freeze({
  usage: 120,
  executableUnavailable: 121,
  materializationFailure: 122,
  profileFailure: 123,
  updateFailure: 124,
  unsupportedEnvironment: 125,
});

export type LauncherExitStatus = (typeof LAUNCHER_EXIT_STATUS)[keyof typeof LAUNCHER_EXIT_STATUS];

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 10,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 30,
  SIGSEGV: 11,
  SIGUSR2: 31,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 20,
  SIGCONT: 19,
  SIGSTOP: 17,
  SIGTSTP: 18,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 16,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 23,
  SIGSYS: 12,
};

export function exitLikeChild(result: {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}): never {
  if (result.signalCode) {
    process.removeAllListeners(result.signalCode);
    process.kill(process.pid, result.signalCode);
    process.exit(128 + (SIGNAL_NUMBERS[result.signalCode] ?? 0));
  }

  process.exit(result.exitCode ?? 1);
}
