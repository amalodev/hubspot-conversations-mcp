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

/**
 * One broker can front two HubSpot apps: the default read+write app
 * (HUBSPOT_OAUTH_CLIENT_ID/SECRET) and an optional read-only app
 * (HUBSPOT_OAUTH_READ_ONLY_CLIENT_ID/SECRET) whose only conversations scope
 * is conversations.read. The client's `login --read-only` selects the
 * read-only app by sending `profile: "read-only"` to /api/exchange and
 * /api/refresh, and /api/config advertises both apps so clients know what is
 * available and which scopes to request.
 */
export type BrokerProfileName = "read-write" | "read-only";

export interface BrokerAppProfile {
  clientId: string;
  clientSecret: string;
  /**
   * Scope profile advertised via /api/config so `login` requests exactly
   * what this app is configured for: `scopes` go in the authorize URL's
   * `scope` param, `optionalScopes` in `optional_scope`. Unset on the
   * read-write app means the client uses its built-in defaults; the
   * read-only app defaults to just conversations.read.
   */
  scopes?: string[];
  optionalScopes?: string[];
}

export interface BrokerEnv {
  profiles: Partial<Record<BrokerProfileName, BrokerAppProfile>>;
}

function parseScopeList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(/[\s,]+/).filter(Boolean);
}

export function readBrokerEnv(env: NodeJS.ProcessEnv = process.env): BrokerEnv | undefined {
  const clientId = env.HUBSPOT_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.HUBSPOT_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;

  const profiles: BrokerEnv["profiles"] = {
    "read-write": {
      clientId,
      clientSecret,
      scopes: parseScopeList(env.HUBSPOT_OAUTH_SCOPES),
      optionalScopes: parseScopeList(env.HUBSPOT_OAUTH_OPTIONAL_SCOPES),
    },
  };

  const readOnlyClientId = env.HUBSPOT_OAUTH_READ_ONLY_CLIENT_ID?.trim();
  const readOnlyClientSecret = env.HUBSPOT_OAUTH_READ_ONLY_CLIENT_SECRET?.trim();
  if (readOnlyClientId && readOnlyClientSecret) {
    profiles["read-only"] = {
      clientId: readOnlyClientId,
      clientSecret: readOnlyClientSecret,
      scopes: parseScopeList(env.HUBSPOT_OAUTH_READ_ONLY_SCOPES) ?? ["conversations.read"],
      optionalScopes: parseScopeList(env.HUBSPOT_OAUTH_READ_ONLY_OPTIONAL_SCOPES) ?? [],
    };
  }
  return { profiles };
}

/** Resolve which app a token request addresses; undefined = invalid/unconfigured profile. */
function pickProfile(env: BrokerEnv, requested: unknown): BrokerAppProfile | undefined {
  if (requested === undefined || requested === "read-write") return env.profiles["read-write"];
  if (requested === "read-only") return env.profiles["read-only"];
  return undefined;
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

const PROFILE_ERROR = {
  error: "unknown_profile",
  message:
    'profile must be "read-write" or "read-only", and the read-only app requires ' +
    "HUBSPOT_OAUTH_READ_ONLY_CLIENT_ID and HUBSPOT_OAUTH_READ_ONLY_CLIENT_SECRET on the deployment.",
};

/** POST /api/exchange — { code, redirect_uri, profile? } → HubSpot token response. */
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
  const app = pickProfile(env, body?.profile);
  if (!app) return jsonResponse(400, PROFILE_ERROR);
  return forwardTokenRequest({
    grant_type: "authorization_code",
    client_id: app.clientId,
    client_secret: app.clientSecret,
    redirect_uri: redirectUri,
    code,
  });
}

/** POST /api/refresh — { refresh_token, profile? } → HubSpot token response. */
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
  const app = pickProfile(env, body?.profile);
  if (!app) return jsonResponse(400, PROFILE_ERROR);
  return forwardTokenRequest({
    grant_type: "refresh_token",
    client_id: app.clientId,
    client_secret: app.clientSecret,
    refresh_token: refreshToken,
  });
}

/** GET /api/config — public app metadata so users only need the broker URL. */
export function configHandler(): Response {
  const env = readBrokerEnv();
  if (!env) {
    return jsonResponse(500, { error: "broker_not_configured" });
  }
  const publicProfile = (app: BrokerAppProfile) => ({
    clientId: app.clientId,
    ...(app.scopes?.length ? { scopes: app.scopes } : {}),
    ...(app.optionalScopes ? { optionalScopes: app.optionalScopes } : {}),
  });
  const readWrite = env.profiles["read-write"]!;
  const readOnly = env.profiles["read-only"];
  return jsonResponse(200, {
    // Top-level fields mirror the read-write app for older clients.
    ...publicProfile(readWrite),
    profiles: {
      "read-write": publicProfile(readWrite),
      ...(readOnly ? { "read-only": publicProfile(readOnly) } : {}),
    },
  });
}
