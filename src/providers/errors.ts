import type { Provider } from "../db/schema";

export class ProviderNotImplementedError extends Error {
  readonly provider: Provider;
  readonly operation: string;

  constructor(provider: Provider, operation: string) {
    super(`Provider ${provider} does not implement ${operation} yet`);
    this.name = "ProviderNotImplementedError";
    this.provider = provider;
    this.operation = operation;
  }
}
