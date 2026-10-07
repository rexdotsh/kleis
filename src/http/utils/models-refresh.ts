import { parseBearerToken } from "./bearer";

export const shouldForceRefreshModelsRegistry = (requestUrl: URL): boolean => {
  const refresh = requestUrl.searchParams.get("refresh")?.trim();
  return refresh === "1" || refresh?.toLowerCase() === "true";
};

export const canForceRefreshModelsRegistry = (
  authorization: string | undefined,
  adminToken: string | undefined
): boolean => {
  const configured = adminToken?.trim();
  return Boolean(configured && parseBearerToken(authorization) === configured);
};
