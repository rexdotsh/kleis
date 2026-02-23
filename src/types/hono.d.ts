import "hono";

declare module "hono" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Hono module augmentation requires an interface.
  interface ContextVariableMap {
    proxyApiKeyId: string;
  }
}
