import { HARNESS_REGISTRY } from "../../harnesses/registry.ts";

export function printHarnesses(): void {
  for (const registration of HARNESS_REGISTRY) {
    const aliases =
      registration.aliases.length === 0 ? "" : ` (aliases: ${registration.aliases.join(", ")})`;
    console.log(`${registration.id}${aliases}`);
  }
}
