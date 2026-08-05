export interface HubSpotConfig {
  baseUrl: string;
  apiVersion: string;
  customChannelsApiVersion: string;
  defaultSenderActorId?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubSpotConfig {
  return {
    baseUrl: (env.HUBSPOT_BASE_URL?.trim() || "https://api.hubapi.com").replace(/\/+$/, ""),
    apiVersion: env.HUBSPOT_CONVERSATIONS_API_VERSION?.trim() || "2026-09-beta",
    customChannelsApiVersion: env.HUBSPOT_CUSTOM_CHANNELS_API_VERSION?.trim() || "2026-03",
    defaultSenderActorId: env.HUBSPOT_DEFAULT_SENDER_ACTOR_ID?.trim() || undefined,
  };
}
