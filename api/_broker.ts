/**
 * Shared logic for the stateless OAuth broker (deployed as Vercel functions).
 *
 * The broker is the only place the HubSpot app's client secret lives. It does
 * exactly two things — exchange an authorization code for tokens, and refresh
 * an access token — and stores nothing. All Conversations API traffic goes
 * directly from the user's machine to HubSpot; only this short-lived auth
 * handshake passes through here. Never log request bodies or responses.
 */

const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";

export interface BrokerEnv {
  clientId: string;
  clientSecret: string;
}

export function readBrokerEnv(env: NodeJS.ProcessEnv = process.env): BrokerEnv | undefined {
  const clientId = env.HUBSPOT_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.HUBSPOT_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

/** Only localhost redirects are accepted — auth codes can never leave the user's machine. */
export function isLocalhostRedirect(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await request.json();
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

async function forwardTokenRequest(form: Record<string, string>): Promise<Response> {
  let hubspotResponse: globalThis.Response;
  try {
    hubspotResponse = await fetch(HUBSPOT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    return jsonResponse(502, { error: "hubspot_unreachable" });
  }
  const text = await hubspotResponse.text();
  return new Response(text, {
    status: hubspotResponse.status,
    headers: { "content-type": "application/json" },
  });
}

/** POST /api/exchange — { code, redirect_uri } → HubSpot token response. */
export async function exchangeHandler(request: Request): Promise<Response> {
  const env = readBrokerEnv();
  if (!env) {
    return jsonResponse(500, {
      error: "broker_not_configured",
      message: "Set HUBSPOT_OAUTH_CLIENT_ID and HUBSPOT_OAUTH_CLIENT_SECRET on the deployment.",
    });
  }
  const body = await readJsonBody(request);
  const code = typeof body?.code === "string" ? body.code : undefined;
  const redirectUri = typeof body?.redirect_uri === "string" ? body.redirect_uri : undefined;
  if (!code || !redirectUri) {
    return jsonResponse(400, { error: "invalid_request", message: "code and redirect_uri are required." });
  }
  if (!isLocalhostRedirect(redirectUri)) {
    return jsonResponse(400, { error: "invalid_redirect_uri", message: "redirect_uri must be http://localhost or http://127.0.0.1." });
  }
  return forwardTokenRequest({
    grant_type: "authorization_code",
    client_id: env.clientId,
    client_secret: env.clientSecret,
    redirect_uri: redirectUri,
    code,
  });
}

/** POST /api/refresh — { refresh_token } → HubSpot token response. */
export async function refreshHandler(request: Request): Promise<Response> {
  const env = readBrokerEnv();
  if (!env) {
    return jsonResponse(500, {
      error: "broker_not_configured",
      message: "Set HUBSPOT_OAUTH_CLIENT_ID and HUBSPOT_OAUTH_CLIENT_SECRET on the deployment.",
    });
  }
  const body = await readJsonBody(request);
  const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : undefined;
  if (!refreshToken) {
    return jsonResponse(400, { error: "invalid_request", message: "refresh_token is required." });
  }
  return forwardTokenRequest({
    grant_type: "refresh_token",
    client_id: env.clientId,
    client_secret: env.clientSecret,
    refresh_token: refreshToken,
  });
}

/** GET /api/config — public app metadata so users only need the broker URL. */
export function configHandler(): Response {
  const env = readBrokerEnv();
  if (!env) {
    return jsonResponse(500, { error: "broker_not_configured" });
  }
  return jsonResponse(200, { clientId: env.clientId });
}
