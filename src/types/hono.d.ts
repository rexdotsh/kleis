import "hono";

import type { ProxyRequestBody } from "../http/proxy-routing";
import type { LogFields } from "../utils/log";

declare module "hono" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Hono module augmentation requires an interface.
  interface ContextVariableMap {
    proxyApiKeyAccountScopeIds: string[] | null;
    proxyApiKeyId: string;
    proxyLogContext: LogFields | undefined;
    proxyRequestBody: ProxyRequestBody;
    requestStartedAt: number;
  }
}
