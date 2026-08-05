import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { OAuthTokenProvider } from "./auth.js";
import type { TokenProvider } from "./client.js";

export const DEFAULT_CALLBACK_PORT = 4573;
export const DEFAULT_SCOPES = ["conversations.read", "conversations.write"];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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
): string {
  const url = new URL("https://app.hubspot.com/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
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
  previous?: Pick<TokenStore, "refreshToken" | "hubId" | "user" | "scopes">,
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
  const tokens = await postBroker(store.brokerUrl, "refresh", { refresh_token: store.refreshToken }, fetchImpl);
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

export interface LoginOptions {
  brokerUrl: string;
  clientId?: string;
  scopes?: string[];
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
  const scopes = options.scopes?.length ? options.scopes : DEFAULT_SCOPES;
  const brokerUrl = options.brokerUrl.replace(/\/+$/, "");

  let clientId = options.clientId;
  if (!clientId) {
    const response = await fetchImpl(brokerEndpoint(brokerUrl, "config"));
    const data = (await response.json().catch(() => ({}))) as { clientId?: string };
    if (!response.ok || !data.clientId) {
      throw new Error(
        `Could not fetch the app's client ID from the broker (${brokerEndpoint(brokerUrl, "config")}). ` +
          "Check the broker URL, or pass --client-id explicitly.",
      );
    }
    clientId = data.clientId;
  }

  const redirectUri = `http://localhost:${port}/callback`;
  const state = randomUUID();
  const authorizeUrl = buildAuthorizeUrl(clientId, redirectUri, scopes, state);

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
    const tokens = await postBroker(brokerUrl, "exchange", { code, redirect_uri: redirectUri }, fetchImpl);
    let store = storeFromTokenResponse(brokerUrl, tokens);
    const info = await introspectAccessToken(store.accessToken, fetchImpl);
    if (info) store = { ...store, ...info };
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

/** Resolve the per-user OAuth credentials for the running server. */
export function resolveTokenProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): TokenProvider {
  const store = readTokenStore(env);
  if (store) {
    return new OAuthTokenProvider(store, fetchImpl, env);
  }
  throw new Error(
    "Not signed in to HubSpot. Run `npx hubspot-conversations-mcp login` " +
      "(or `setup`) on this machine first.",
  );
}
