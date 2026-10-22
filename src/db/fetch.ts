import { DependencyError } from "../utils/dependency-error";

const isConnectionReset = (error: unknown): boolean => {
  const seen = new Set<Error>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (
      ("code" in cause &&
        (cause.code === "ECONNRESET" ||
          cause.code === "EPIPE" ||
          cause.code === "ConnectionClosed" ||
          cause.code === "UND_ERR_SOCKET")) ||
      /^(?:ECONNRESET: )?The socket connection was closed unexpectedly\b|^socket hang up$/iu.test(
        cause.message
      )
    ) {
      return true;
    }
    cause = cause.cause;
  }
  return false;
};

export const fetchDatabase = async (request: Request): Promise<Response> => {
  try {
    const retry = request.clone();
    try {
      return await fetch(request);
    } catch (error) {
      if (request.signal.aborted || !isConnectionReset(error)) throw error;
      return await fetch(retry, { keepalive: false });
    }
  } catch (error) {
    throw new DependencyError("db", error);
  }
};
