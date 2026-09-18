// DeputyDev core OpenCode server plugin.
//
// Bundled into the DeputyDev binary, materialized into a content-keyed runtime
// directory, and enabled through the generated `OPENCODE_CONFIG_CONTENT`
// `plugins` array. OpenCode V2 server plugins are plain objects with `id` and
// `setup`; the setup contract was verified against 0.0.0-beta-19086.
//
// Keep this file dependency-free: it is imported by the OpenCode server in the
// user's project context, where only this runtime directory is guaranteed.

const PLUGIN_ID = "deputydev-core";

export const plugin = {
  id: PLUGIN_ID,
  setup() {
    // The core plugin currently only establishes DeputyDev's presence in the
    // server plugin registry; behavioral hooks land with real features.
  },
};

export default plugin;
