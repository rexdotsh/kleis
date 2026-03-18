import "hono";

declare module "hono" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Hono module augmentation requires an interface.
  interface ContextVariableMap {
    proxyApiKeyAccountScopeIds: string[] | null;
    proxyApiKeyId: string;
  }
}
