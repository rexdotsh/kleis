import "hono";

import type { ApiKeyRecord } from "../db/repositories/api-keys";
import type { ProxyRequestBody } from "../http/proxy-routing";
import type { LogFields } from "../utils/log";

declare module "hono" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Hono module augmentation requires an interface.
  interface ContextVariableMap {
    apiKey: ApiKeyRecord;
    proxyApiKeyAccountScopeIds: string[] | null;
    proxyApiKeyId: string;
    proxyLogContext: LogFields | undefined;
    proxyRequestBody: ProxyRequestBody;
    requestStartedAt: number;
  }
}
