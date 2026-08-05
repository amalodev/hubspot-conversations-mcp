export type AuthMode = "bearer" | "private-app";

export interface HubSpotConfig {
  accessToken: string;
  baseUrl: string;
  apiVersion: string;
  customChannelsApiVersion: string;
  authMode: AuthMode;
  defaultSenderActorId?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubSpotConfig {
  const accessToken = env.HUBSPOT_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error(
      "HUBSPOT_ACCESS_TOKEN is not set. Create a HubSpot service key (Development → Keys → " +
        "Service Keys) with the conversations.read and conversations.write scopes and set it here. " +
        "Legacy private app tokens and OAuth2 access tokens also work.",
    );
  }

  const rawAuthMode = env.HUBSPOT_AUTH_MODE?.trim().toLowerCase();
  let authMode: AuthMode;
  if (rawAuthMode === "bearer" || rawAuthMode === "private-app") {
    authMode = rawAuthMode;
  } else if (rawAuthMode) {
    throw new Error(`HUBSPOT_AUTH_MODE must be "bearer" or "private-app", got "${rawAuthMode}".`);
  } else {
    // Bearer works for service keys, legacy private app tokens and OAuth2 alike;
    // the legacy `private-app` header is opt-in via HUBSPOT_AUTH_MODE.
    authMode = "bearer";
  }

  return {
    accessToken,
    baseUrl: (env.HUBSPOT_BASE_URL?.trim() || "https://api.hubapi.com").replace(/\/+$/, ""),
    apiVersion: env.HUBSPOT_CONVERSATIONS_API_VERSION?.trim() || "2026-09-beta",
    customChannelsApiVersion: env.HUBSPOT_CUSTOM_CHANNELS_API_VERSION?.trim() || "2026-03",
    authMode,
    defaultSenderActorId: env.HUBSPOT_DEFAULT_SENDER_ACTOR_ID?.trim() || undefined,
  };
}
