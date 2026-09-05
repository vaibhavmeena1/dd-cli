import type {
  HarnessAdapter,
  HarnessRegistration,
  StableHarnessId,
} from "../launcher/contracts.ts";

export const HARNESS_REGISTRY = Object.freeze([
  {
    id: "pi",
    aliases: [],
    executableCandidates: ["pi"],
    executableOverrideVariable: "DEPUTYDEV_PI_BIN",
  },
  {
    id: "opencode",
    aliases: ["opencode2"],
    executableCandidates: ["opencode", "opencode2"],
    executableOverrideVariable: "DEPUTYDEV_OPENCODE_BIN",
  },
] as const satisfies readonly HarnessRegistration[]);

export function resolveHarnessRegistration(token: string): HarnessRegistration | undefined {
  return HARNESS_REGISTRY.find(
    (registration) =>
      registration.id === token || registration.aliases.some((alias) => alias === token),
  );
}

export async function loadHarnessAdapter(id: StableHarnessId): Promise<HarnessAdapter> {
  const adapter =
    id === "pi"
      ? (await import("./pi/adapter.ts")).createPiAdapter()
      : (await import("./opencode/adapter.ts")).createOpenCodeAdapter();

  if (adapter.id !== id) {
    throw new Error(`adapter identity mismatch: expected ${id}, received ${adapter.id}`);
  }

  return adapter;
}
