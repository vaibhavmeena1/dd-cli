import deputyDevExtensionAsset from "../harnesses/pi/resources/extensions/deputydev.ts" with {
  type: "file",
};

import {
  type PiResourceManifestEntry,
  parseDeputyDevManifest,
} from "../harnesses/pi/setup/packages/manifest.ts";

const DEPUTYDEV_CORE_RESOURCE = Object.freeze({
  id: "deputydev-core",
  type: "extension",
  destination: "pi/extensions/deputydev.ts",
}) satisfies PiResourceManifestEntry;

export const DEPUTYDEV_MANIFEST = parseDeputyDevManifest({
  schemaVersion: 1,
  revision: "2",
  pi: {
    packages: [
      {
        id: "pi-mcp-adapter",
        source: "npm:pi-mcp-adapter",
        required: true,
        versionPolicy: { kind: "floating" },
        install: { action: "pi.install" },
        updates: { owner: "pi-or-user" },
      },
      {
        id: "rpiv-ask-user-question",
        source: "npm:@juicesharp/rpiv-ask-user-question",
        required: true,
        versionPolicy: { kind: "floating" },
        install: { action: "pi.install" },
        updates: { owner: "pi-or-user" },
      },
      {
        id: "pi-provider-litellm",
        source: "npm:pi-provider-litellm",
        required: true,
        versionPolicy: { kind: "exact", version: "2.3.0" },
        install: { action: "pi.install" },
      },
    ],
    resources: [DEPUTYDEV_CORE_RESOURCE],
  },
});

export interface EmbeddedPiResource extends PiResourceManifestEntry {
  readonly sourcePath: string;
}

export const EMBEDDED_PI_RESOURCES = Object.freeze([
  Object.freeze({
    ...DEPUTYDEV_CORE_RESOURCE,
    // TypeScript resolves the source module while Bun's `file` loader returns its asset path.
    sourcePath: deputyDevExtensionAsset as unknown as string,
  }),
] as const satisfies readonly EmbeddedPiResource[]);
