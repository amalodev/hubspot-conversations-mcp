import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { OAuthTokenProvider } from "./auth.js";
import type { TokenProvider } from "./client.js";

export const DEFAULT_CALLBACK_PORT = 4573;
/**
 * Default scopes, split the way HubSpot's authorize URL demands: scopes the
 * app marks *required* go in `scope`, scopes it marks *optional* go in
 * `optional_scope` — an app-optional scope listed in `scope` (or a required
 * one missing from it) makes HubSpot reject the consent screen outright.
 * These defaults match the app template in the README (write is optional).
 */
export const DEFAULT_SCOPES = ["conversations.read"];
export const DEFAULT_OPTIONAL_SCOPES = ["conversations.write"];
/** Requested by `login --read-only` — needs conversations.write to be an *optional* scope on the app. */
export const READ_ONLY_SCOPES = ["conversations.read"];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Which of the broker's HubSpot apps a sign-in went through. */
export type LoginProfile = "read-write" | "read-only";

export interface TokenStore {
  version: 1;
  brokerUrl: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when accessToken expires. */
  expiresAt: number;
  hubId?: number;
  user?: string;
  scopes?: string[];
  /** Broker app profile the tokens belong to — refreshes must use the same app's credentials. */
  profile?: LoginProfile;
}

export function tokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HUBSPOT_TOKEN_STORE_PATH?.trim();
  if (override) return override;
  return path.join(homedir(), ".hubspot-conversations-mcp", "tokens.json");
}

export function readTokenStore(env: NodeJS.ProcessEnv = process.env): TokenStore | undefined {
  const filePath = tokenStorePath(env);
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as TokenStore;
    if (parsed.accessToken && parsed.refreshToken && parsed.brokerUrl) return parsed;
  } catch {
    // treat unreadable stores as absent
  }
  return undefined;
}

export function writeTokenStore(store: TokenStore, env: NodeJS.ProcessEnv = process.env): string {
  const filePath = tokenStorePath(env);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`);
  chmodSync(filePath, 0o600);
  return filePath;
}

export function clearTokenStore(env: NodeJS.ProcessEnv = process.env): boolean {
  const filePath = tokenStorePath(env);
  if (!existsSync(filePath)) return false;
  rmSync(filePath);
  return true;
}

export function brokerEndpoint(brokerUrl: string, name: string): string {
  const base = brokerUrl.endsWith("/") ? brokerUrl : `${brokerUrl}/`;
  return new URL(`api/${name}`, base).toString();
}

export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  scopes: string[],
  state: string,
  optionalScopes: string[] = [],
): string {
  const url = new URL("https://app.hubspot.com/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  if (optionalScopes.length > 0) {
    url.searchParams.set("optional_scope", optionalScopes.join(" "));
  }
  url.searchParams.set("state", state);
  return url.toString();
}

interface HubSpotTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  message?: string;
  error?: string;
}

export function storeFromTokenResponse(
  brokerUrl: string,
  tokens: HubSpotTokenResponse,
  previous?: Pick<TokenStore, "refreshToken" | "hubId" | "user" | "scopes" | "profile">,
): TokenStore {
  if (!tokens.access_token) {
    throw new Error(tokens.message ?? tokens.error ?? "Token response had no access_token.");
  }
  return {
    version: 1,
    brokerUrl,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? "",
    expiresAt: Date.now() + (tokens.expires_in ?? 1800) * 1000,
    hubId: previous?.hubId,
    user: previous?.user,
    scopes: previous?.scopes,
    profile: previous?.profile,
  };
}

async function postBroker(
  brokerUrl: string,
  endpoint: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<HubSpotTokenResponse> {
  const response = await fetchImpl(brokerEndpoint(brokerUrl, endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as HubSpotTokenResponse;
  if (!response.ok) {
    throw new Error(
      `Broker ${endpoint} failed (${response.status}): ${data.message ?? data.error ?? "unknown error"}`,
    );
  }
  return data;
}

export async function refreshViaBroker(
  store: TokenStore,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TokenStore> {
  const tokens = await postBroker(
    store.brokerUrl,
    "refresh",
    {
      refresh_token: store.refreshToken,
      // The broker must refresh with the same app's credentials the tokens came from.
      ...(store.profile === "read-only" ? { profile: store.profile } : {}),
    },
    fetchImpl,
  );
  const updated = storeFromTokenResponse(store.brokerUrl, tokens, store);
  writeTokenStore(updated, env);
  return updated;
}

/** Best-effort metadata about an OAuth access token (no auth required). */
export async function introspectAccessToken(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ hubId?: number; user?: string; scopes?: string[] } | undefined> {
  try {
    const response = await fetchImpl(
      `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`,
    );
    if (!response.ok) return undefined;
    const data = (await response.json()) as { hub_id?: number; user?: string; scopes?: string[] };
    return { hubId: data.hub_id, user: data.user, scopes: data.scopes };
  } catch {
    return undefined;
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else if (platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // the URL is always printed as fallback
  }
}

const CALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>hubspot-conversations-mcp</title>
<body style="font-family: system-ui; display: grid; place-items: center; height: 90vh">
<div style="text-align: center"><h2>%TITLE%</h2><p>%MESSAGE%</p></div></body>`;

function htmlResponse(title: string, message: string): string {
  return CALLBACK_HTML.replace("%TITLE%", title).replace("%MESSAGE%", message);
}

function waitForCallback(
  server: Server,
  expectedState: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for the browser authorization (5 minutes)."));
    }, LOGIN_TIMEOUT_MS);

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error) {
        response.writeHead(200, { "content-type": "text/html", connection: "close" });
        response.end(htmlResponse("Authorization denied", "You can close this window."));
        clearTimeout(timeout);
        reject(new Error(`HubSpot returned an error: ${error}`));
        return;
      }
      if (!code || state !== expectedState) {
        response.writeHead(400, { "content-type": "text/html", connection: "close" });
        response.end(htmlResponse("Invalid callback", "Missing code or state mismatch — try again."));
        return;
      }
      response.writeHead(200, { "content-type": "text/html", connection: "close" });
      response.end(htmlResponse("Signed in ✔", "You can close this window and return to the terminal."));
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

/** Scope profile a broker may advertise via /api/config (matching its app's config). */
export interface BrokerScopeProfile {
  scopes?: string[];
  optionalScopes?: string[];
}

/**
 * Resolve which scopes a login requests: explicit options win, then the
 * broker-advertised profile, then the built-in defaults. An explicit `scopes`
 * list takes full control — no optional scopes are added to it implicitly.
 */
export function resolveRequestedScopes(
  options: Pick<LoginOptions, "scopes" | "optionalScopes">,
  broker: BrokerScopeProfile = {},
): { scopes: string[]; optionalScopes: string[] } {
  if (options.scopes?.length) {
    return { scopes: options.scopes, optionalScopes: options.optionalScopes ?? [] };
  }
  if (broker.scopes?.length) {
    return {
      scopes: broker.scopes,
      optionalScopes: options.optionalScopes ?? broker.optionalScopes ?? [],
    };
  }
  return {
    scopes: DEFAULT_SCOPES,
    optionalScopes: options.optionalScopes ?? DEFAULT_OPTIONAL_SCOPES,
  };
}

export interface LoginOptions {
  brokerUrl: string;
  clientId?: string;
  /**
   * Which of the broker's apps to sign in through. "read-only" uses the
   * broker's read-only app (HUBSPOT_OAUTH_READ_ONLY_* on the deployment) and
   * fails with a clear error when the broker has none. Default "read-write".
   */
  profile?: LoginProfile;
  /** Scopes for the authorize URL's `scope` param (app-required scopes). */
  scopes?: string[];
  /**
   * Scopes for the `optional_scope` param (app-optional scopes). Defaults to
   * DEFAULT_OPTIONAL_SCOPES only when `scopes` is also defaulted — an explicit
   * scope list takes full control of the request.
   */
  optionalScopes?: string[];
  port?: number;
  openBrowser?: boolean;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export async function runLogin(options: LoginOptions): Promise<TokenStore> {
  const log = options.log ?? console.log;
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const port = options.port ?? DEFAULT_CALLBACK_PORT;
  const brokerUrl = options.brokerUrl.replace(/\/+$/, "");
  const profile: LoginProfile = options.profile ?? "read-write";

  let clientId = options.clientId;
  let brokerProfile: BrokerScopeProfile = {};
  if (!clientId) {
    const response = await fetchImpl(brokerEndpoint(brokerUrl, "config"));
    interface ConfigEntry {
      clientId?: string;
      scopes?: unknown;
      optionalScopes?: unknown;
    }
    const data = (await response.json().catch(() => ({}))) as ConfigEntry & {
      profiles?: Record<string, ConfigEntry | undefined>;
    };
    if (!response.ok || !data.clientId) {
      throw new Error(
        `Could not fetch the app's client ID from the broker (${brokerEndpoint(brokerUrl, "config")}). ` +
          "Check the broker URL, or pass --client-id explicitly.",
      );
    }
    // Top-level config fields mirror the read-write app (older brokers only have those).
    const entry = profile === "read-only" ? data.profiles?.["read-only"] : (data.profiles?.["read-write"] ?? data);
    if (profile === "read-only" && !entry?.clientId) {
      throw new Error(
        "This broker has no read-only app configured — set HUBSPOT_OAUTH_READ_ONLY_CLIENT_ID and " +
          "HUBSPOT_OAUTH_READ_ONLY_CLIENT_SECRET on the broker deployment (see the README's " +
          "read-only section).",
      );
    }
    clientId = entry!.clientId!;
    const asScopeList = (value: unknown): string[] | undefined =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
    brokerProfile = { scopes: asScopeList(entry!.scopes), optionalScopes: asScopeList(entry!.optionalScopes) };
  }
  let { scopes, optionalScopes } = resolveRequestedScopes(options, brokerProfile);
  if (profile === "read-only" && !options.scopes?.length && !brokerProfile.scopes?.length) {
    // Safety net when the read-only app's scopes weren't advertised (e.g. --client-id given).
    scopes = [...READ_ONLY_SCOPES];
    optionalScopes = options.optionalScopes ?? [];
  }

  const redirectUri = `http://localhost:${port}/callback`;
  const state = randomUUID();
  const authorizeUrl = buildAuthorizeUrl(clientId, redirectUri, scopes, state, optionalScopes);
  log(
    `Requesting scopes: ${scopes.join(", ")}` +
      (optionalScopes.length > 0 ? ` (optional: ${optionalScopes.join(", ")})` : ""),
  );

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} is in use — pass --port or free the port.`)
          : error,
      );
    });
    server.listen(port, "127.0.0.1", resolve);
  });

  try {
    log(`Open this URL in your browser to sign in to HubSpot:\n  ${authorizeUrl}`);
    if (options.openBrowser !== false) openBrowser(authorizeUrl);

    const code = await waitForCallback(server, state);
    const tokens = await postBroker(
      brokerUrl,
      "exchange",
      {
        code,
        redirect_uri: redirectUri,
        ...(profile === "read-only" ? { profile } : {}),
      },
      fetchImpl,
    );
    let store = { ...storeFromTokenResponse(brokerUrl, tokens), profile };
    const info = await introspectAccessToken(store.accessToken, fetchImpl);
    if (info) store = { ...store, ...info };
    if (!store.scopes?.length) {
      // The recorded scopes drive which tools the server offers. When
      // introspection fails, record what was requested (granted ⊆ requested)
      // rather than leaving them unknown, which would offer every tool — the
      // opposite of what e.g. a --read-only sign-in asked for.
      store = { ...store, scopes: [...scopes, ...optionalScopes] };
      log(
        "Note: could not verify the granted scopes with HubSpot — recorded the requested " +
          "scopes instead. Re-run login later to record the actual grants.",
      );
    }
    const previous = readTokenStore(env);
    if (previous && (previous.profile ?? "read-write") !== profile) {
      log(
        `Warning: this replaces the ${previous.profile ?? "read-write"} sign-in stored at this path — ` +
          "set HUBSPOT_TOKEN_STORE_PATH to keep both access levels side by side.",
      );
    }
    const filePath = writeTokenStore(store, env);
    log(
      `✔ Signed in${store.user ? ` as ${store.user}` : ""}${store.hubId ? ` (portal ${store.hubId})` : ""}. ` +
        `Tokens stored in ${filePath}.`,
    );
    return store;
  } finally {
    // close() alone waits for the browser's keep-alive socket and would hang
    // the process after a successful login — force-close open connections.
    server.close();
    server.closeAllConnections();
  }
}

export interface Session {
  provider: TokenProvider;
  /** Scopes granted at login (from token introspection); undefined when unknown. */
  grantedScopes?: string[];
}

/** Resolve the per-user OAuth credentials and granted scopes for the running server. */
export function resolveSession(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Session {
  const store = readTokenStore(env);
  if (store) {
    return {
      provider: new OAuthTokenProvider(store, fetchImpl, env),
      grantedScopes: store.scopes,
    };
  }
  throw new Error(
    "Not signed in to HubSpot. Run `npx hubspot-conversations-mcp login` " +
      "(or `setup`) on this machine first.",
  );
}
