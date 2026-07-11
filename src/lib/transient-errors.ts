function errorText(error: unknown) {
  const fields =
    error && typeof error === "object"
      ? Object.values(error as Record<string, unknown>).join(" ")
      : String(error ?? "");
  return `${error instanceof Error ? error.message : ""} ${fields}`.toLowerCase();
}

export function isTransientDataApiError(error: unknown) {
  const message = errorText(error);
  return (
    message.includes("schema cache") ||
    message.includes("pgrst002") ||
    message.includes("503") ||
    message.includes("service unavailable") ||
    message.includes("context deadline exceeded") ||
    message.includes("context canceled") ||
    message.includes("request_timeout") ||
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("connection")
  );
}

export function isAuthTokenError(error: unknown) {
  const message = errorText(error);
  return (
    message.includes("unauthorized: invalid token") ||
    message.includes("invalid token") ||
    message.includes("jwt expired") ||
    message.includes("invalid jwt") ||
    message.includes("malformed jwt") ||
    message.includes("session expired") ||
    message.includes("auth session missing") ||
    message.includes("expected 3 parts in jwt") ||
    message.includes("no authorization header") ||
    message.includes("401")
  );
}

export function isRecoverableDataReadError(error: unknown) {
  return isTransientDataApiError(error) || isAuthTokenError(error);
}