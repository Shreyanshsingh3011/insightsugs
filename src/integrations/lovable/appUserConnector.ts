/**
 * App User Connector helpers — SERVER ONLY.
 * Reads LOVABLE_API_KEY from process.env. Never import from browser code.
 */

function requireApiKey(): string {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) {
    throw new Error(
      "LOVABLE_API_KEY is not set. App User Connector calls require a server-side workspace token.",
    );
  }
  return key;
}

export interface AppUserOAuthAuthorizeParams {
  gatewayBaseUrl: string;
  connectorId: string;
  appUserId: string;
  connectorClientId: string;
  returnUrl: string;
  credentialsConfiguration?: Record<string, unknown>;
  responseMode?: "redirect" | "web_message";
  webMessageTargetOrigin?: string;
}

export interface AppUserOAuthAuthorizeResponse {
  authorizationUrl: string;
  sessionId: string;
}

export async function authorizeAppUserOAuth(
  params: AppUserOAuthAuthorizeParams,
): Promise<AppUserOAuthAuthorizeResponse> {
  const res = await fetch(`${params.gatewayBaseUrl}/api/v1/app-users/oauth2/authorize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      connector_id: params.connectorId,
      app_user_id: params.appUserId,
      connector_client_id: params.connectorClientId,
      return_url: params.returnUrl,
      credentials_configuration: params.credentialsConfiguration,
      response_mode: params.responseMode,
      web_message_target_origin: params.webMessageTargetOrigin,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`App User OAuth start failed (${res.status}): ${text || res.statusText}`);
  }

  let body: { authorization_url?: string; session_id?: string };
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`App User OAuth start returned invalid JSON: ${text.slice(0, 200)}`);
  }
  if (!body.authorization_url) {
    throw new Error("App User OAuth start response missing authorization_url");
  }
  return {
    authorizationUrl: body.authorization_url,
    sessionId: body.session_id ?? "",
  };
}

export interface CallAsAppUserParams {
  gatewayBaseUrl: string;
  connectionId: string;
  connectorId: string;
  path: string;
  init?: RequestInit;
}

export async function callAsAppUser({
  gatewayBaseUrl,
  connectionId,
  connectorId,
  path,
  init,
}: CallAsAppUserParams): Promise<Response> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${requireApiKey()}`);
  headers.set("X-App-User-Connection-Id", connectionId);
  return fetch(`${gatewayBaseUrl}/${connectorId}${normalizedPath}`, {
    ...init,
    headers,
  });
}
