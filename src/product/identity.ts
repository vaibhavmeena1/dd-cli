export const PRODUCT_IDENTITY = Object.freeze({
  applicationId: "deputydev",
  command: "ddcli",
  displayName: "DeputyDev",
  homeEnvironmentVariable: "DEPUTYDEV_HOME",
  defaultHomeDirectoryName: ".deputydev",
});

export type ProductIdentity = typeof PRODUCT_IDENTITY;
