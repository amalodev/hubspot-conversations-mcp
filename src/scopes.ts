/** HubSpot OAuth scopes that gate which tools the server offers. */
export type HubSpotScope =
  | "conversations.read"
  | "conversations.write"
  | "conversations.custom_channels.read"
  | "conversations.custom_channels.write";

export type ScopeCheck = (scope: HubSpotScope) => boolean;

/**
 * Build the availability check used during tool registration from the scopes
 * granted at login. When the store has no recorded scopes (only happens when
 * scope introspection failed during a pre-0.11 login) every tool is offered —
 * HubSpot enforces scopes server-side regardless; gating only keeps the tool
 * list truthful.
 */
export function scopeChecker(granted?: string[]): ScopeCheck {
  if (!granted || granted.length === 0) return () => true;
  const set = new Set(granted);
  return (scope) => set.has(scope);
}

const WRITE_SCOPES: readonly string[] = [
  "conversations.write",
  "conversations.custom_channels.write",
];

/**
 * Whether the granted scopes include any write scope — i.e. whether the
 * server registers any mutating tool. Undefined when scopes are unknown
 * (fail-open: all tools registered).
 */
export function grantsWriteAccess(granted?: string[]): boolean | undefined {
  if (!granted || granted.length === 0) return undefined;
  return granted.some((scope) => WRITE_SCOPES.includes(scope));
}
