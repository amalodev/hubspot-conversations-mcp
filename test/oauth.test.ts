import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configHandler, exchangeHandler, isLocalhostRedirect, refreshHandler } from "../api/_broker.js";
import { OAuthTokenProvider } from "../src/auth.js";
import { HubSpotClient, type TokenProvider } from "../src/client.js";
import type { HubSpotConfig } from "../src/config.js";
import {
  brokerEndpoint,
  buildAuthorizeUrl,
  readTokenStore,
  resolveRequestedScopes,
  storeFromTokenResponse,
  tokenStorePath,
  writeTokenStore,
  type TokenStore,
} from "../src/oauth.js";

// --- Broker handlers ---------------------------------------------------------

describe("OAuth broker handlers", () => {
  beforeEach(() => {
    vi.stubEnv("HUBSPOT_OAUTH_CLIENT_ID", "client-123");
    vi.stubEnv("HUBSPOT_OAUTH_CLIENT_SECRET", "secret-456");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stubHubSpotToken(response: { status?: number; json: unknown }) {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
      return new Response(JSON.stringify(response.json), {
        status: response.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    });
    return calls;
  }

  it("exchanges a code, forwarding the client secret server-side", async () => {
    const calls = stubHubSpotToken({
      json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 1800 },
    });
    const response = await exchangeHandler(
      new Request("https://broker.test/api/exchange", {
        method: "POST",
        body: JSON.stringify({ code: "code-9", redirect_uri: "http://localhost:4573/callback" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ access_token: "at-1" });
    expect(calls[0].url).toBe("https://api.hubapi.com/oauth/v1/token");
    expect(Object.fromEntries(calls[0].body)).toEqual({
      grant_type: "authorization_code",
      client_id: "client-123",
      client_secret: "secret-456",
      redirect_uri: "http://localhost:4573/callback",
      code: "code-9",
    });
  });

  it("rejects non-localhost redirect URIs", async () => {
    const response = await exchangeHandler(
      new Request("https://broker.test/api/exchange", {
        method: "POST",
        body: JSON.stringify({ code: "x", redirect_uri: "https://evil.example/callback" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("refreshes tokens and passes HubSpot errors through", async () => {
    const calls = stubHubSpotToken({ status: 400, json: { message: "BAD_REFRESH_TOKEN" } });
    const response = await refreshHandler(
      new Request("https://broker.test/api/refresh", {
        method: "POST",
        body: JSON.stringify({ refresh_token: "rt-dead" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(Object.fromEntries(calls[0].body)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-dead",
    });
  });

  it("exposes the client ID and read-write profile via /api/config", async () => {
    const response = configHandler();
    expect(await response.json()).toEqual({
      clientId: "client-123",
      profiles: { "read-write": { clientId: "client-123" } },
    });
  });

  it("advertises the app's scope profile via /api/config when configured", async () => {
    vi.stubEnv("HUBSPOT_OAUTH_SCOPES", "conversations.read");
    vi.stubEnv("HUBSPOT_OAUTH_OPTIONAL_SCOPES", "conversations.write, conversations.custom_channels.read");
    const response = configHandler();
    expect(await response.json()).toMatchObject({
      clientId: "client-123",
      scopes: ["conversations.read"],
      optionalScopes: ["conversations.write", "conversations.custom_channels.read"],
    });
  });

  it("advertises the read-only app with default scopes when its env pair is set", async () => {
    vi.stubEnv("HUBSPOT_OAUTH_READ_ONLY_CLIENT_ID", "ro-client");
    vi.stubEnv("HUBSPOT_OAUTH_READ_ONLY_CLIENT_SECRET", "ro-secret");
    const response = configHandler();
    expect(await response.json()).toEqual({
      clientId: "client-123",
      profiles: {
        "read-write": { clientId: "client-123" },
        "read-only": { clientId: "ro-client", scopes: ["conversations.read"], optionalScopes: [] },
      },
    });
  });

  it("exchanges and refreshes against the read-only app when profile is read-only", async () => {
    vi.stubEnv("HUBSPOT_OAUTH_READ_ONLY_CLIENT_ID", "ro-client");
    vi.stubEnv("HUBSPOT_OAUTH_READ_ONLY_CLIENT_SECRET", "ro-secret");
    const calls = stubHubSpotToken({ json: { access_token: "at", expires_in: 1800 } });

    await exchangeHandler(
      new Request("https://broker.test/api/exchange", {
        method: "POST",
        body: JSON.stringify({
          code: "c1",
          redirect_uri: "http://localhost:4573/callback",
          profile: "read-only",
        }),
      }),
    );
    expect(Object.fromEntries(calls[0].body)).toMatchObject({
      client_id: "ro-client",
      client_secret: "ro-secret",
    });

    await refreshHandler(
      new Request("https://broker.test/api/refresh", {
        method: "POST",
        body: JSON.stringify({ refresh_token: "rt", profile: "read-only" }),
      }),
    );
    expect(Object.fromEntries(calls[1].body)).toMatchObject({
      client_id: "ro-client",
      client_secret: "ro-secret",
    });
  });

  it("rejects a read-only profile request when no read-only app is configured", async () => {
    const response = await refreshHandler(
      new Request("https://broker.test/api/refresh", {
        method: "POST",
        body: JSON.stringify({ refresh_token: "rt", profile: "read-only" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unknown_profile" });
  });

  it("returns broker_not_configured without env", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("HUBSPOT_OAUTH_CLIENT_ID", "");
    const response = await exchangeHandler(
      new Request("https://broker.test/api/exchange", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(500);
  });

  it("validates localhost redirects strictly", () => {
    expect(isLocalhostRedirect("http://localhost:4573/callback")).toBe(true);
    expect(isLocalhostRedirect("http://127.0.0.1:9999/callback")).toBe(true);
    expect(isLocalhostRedirect("https://localhost:4573/callback")).toBe(false);
    expect(isLocalhostRedirect("http://localhost.evil.example/callback")).toBe(false);
    expect(isLocalhostRedirect("not a url")).toBe(false);
  });
});

// --- Token store & helpers ---------------------------------------------------

describe("token store", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-mcp-test-"));
    env = { HUBSPOT_TOKEN_STORE_PATH: path.join(dir, "tokens.json") };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips and respects the path override", () => {
    expect(readTokenStore(env)).toBeUndefined();
    const store: TokenStore = {
      version: 1,
      brokerUrl: "https://broker.test",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 1000,
    };
    const filePath = writeTokenStore(store, env);
    expect(filePath).toBe(env.HUBSPOT_TOKEN_STORE_PATH);
    expect(readTokenStore(env)).toEqual(store);
    expect(tokenStorePath(env)).toBe(filePath);
  });

  it("builds authorize URLs and broker endpoints", () => {
    const url = new URL(buildAuthorizeUrl("cid", "http://localhost:4573/callback", ["a.read", "b.write"], "state-1"));
    expect(url.origin + url.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("scope")).toBe("a.read b.write");
    expect(url.searchParams.get("optional_scope")).toBeNull();
    expect(url.searchParams.get("state")).toBe("state-1");

    expect(brokerEndpoint("https://b.test", "refresh")).toBe("https://b.test/api/refresh");
    expect(brokerEndpoint("https://b.test/", "config")).toBe("https://b.test/api/config");
  });

  it("puts app-optional scopes in optional_scope, not scope", () => {
    const url = new URL(
      buildAuthorizeUrl(
        "cid",
        "http://localhost:4573/callback",
        ["conversations.read"],
        "state-2",
        ["conversations.write", "conversations.custom_channels.write"],
      ),
    );
    expect(url.searchParams.get("scope")).toBe("conversations.read");
    expect(url.searchParams.get("optional_scope")).toBe(
      "conversations.write conversations.custom_channels.write",
    );
  });

  it("resolves requested scopes: explicit flags > broker profile > defaults", () => {
    // Built-in defaults.
    expect(resolveRequestedScopes({})).toEqual({
      scopes: ["conversations.read"],
      optionalScopes: ["conversations.write"],
    });
    // A broker-advertised profile replaces the defaults entirely — a
    // read-only broker advertising just conversations.read requests no write.
    expect(resolveRequestedScopes({}, { scopes: ["conversations.read"] })).toEqual({
      scopes: ["conversations.read"],
      optionalScopes: [],
    });
    expect(
      resolveRequestedScopes({}, { scopes: ["a.read"], optionalScopes: ["a.write"] }),
    ).toEqual({ scopes: ["a.read"], optionalScopes: ["a.write"] });
    // Explicit scopes take full control, regardless of broker profile.
    expect(
      resolveRequestedScopes({ scopes: ["x.read"] }, { scopes: ["a.read"], optionalScopes: ["a.write"] }),
    ).toEqual({ scopes: ["x.read"], optionalScopes: [] });
    // --read-only shape: explicit read + explicitly no optional scopes.
    expect(resolveRequestedScopes({ scopes: ["conversations.read"], optionalScopes: [] })).toEqual({
      scopes: ["conversations.read"],
      optionalScopes: [],
    });
    // Explicit optional scopes override the broker's optional list.
    expect(
      resolveRequestedScopes({ optionalScopes: ["b.write"] }, { scopes: ["a.read"], optionalScopes: ["a.write"] }),
    ).toEqual({ scopes: ["a.read"], optionalScopes: ["b.write"] });
  });

  it("maps token responses and keeps the previous refresh token", () => {
    const store = storeFromTokenResponse(
      "https://b.test",
      { access_token: "new-at", expires_in: 1800 },
      { refreshToken: "old-rt", hubId: 7, user: "k@amalo.dk", scopes: ["conversations.read"] },
    );
    expect(store.accessToken).toBe("new-at");
    expect(store.refreshToken).toBe("old-rt");
    expect(store.hubId).toBe(7);
    expect(store.expiresAt).toBeGreaterThan(Date.now());
    expect(() => storeFromTokenResponse("https://b.test", { message: "denied" })).toThrow(/denied/);
  });
});

// --- OAuth provider + client 401 retry ---------------------------------------

describe("OAuthTokenProvider", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-mcp-test-"));
    env = { HUBSPOT_TOKEN_STORE_PATH: path.join(dir, "tokens.json") };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refreshes expired tokens through the broker and persists the result", async () => {
    const store: TokenStore = {
      version: 1,
      brokerUrl: "https://broker.test",
      accessToken: "stale",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 1000,
    };
    writeTokenStore(store, env);

    const fetchStub = (async (url: string | URL) => {
      expect(String(url)).toBe("https://broker.test/api/refresh");
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 1800 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new OAuthTokenProvider(store, fetchStub, env);
    expect(await provider.getAuthHeaders()).toEqual({ authorization: "Bearer fresh" });
    const persisted = JSON.parse(readFileSync(env.HUBSPOT_TOKEN_STORE_PATH!, "utf8")) as TokenStore;
    expect(persisted.accessToken).toBe("fresh");
    expect(persisted.refreshToken).toBe("rt-1");
  });

  it("refreshes read-only tokens with the read-only profile so the broker picks the right app", async () => {
    const store: TokenStore = {
      version: 1,
      brokerUrl: "https://broker.test",
      accessToken: "stale",
      refreshToken: "rt-ro",
      expiresAt: Date.now() - 1000,
      scopes: ["oauth", "conversations.read"],
      profile: "read-only",
    };
    writeTokenStore(store, env);

    const bodies: unknown[] = [];
    const fetchStub = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ access_token: "fresh-ro", expires_in: 1800 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new OAuthTokenProvider(store, fetchStub, env);
    expect(await provider.getAuthHeaders()).toEqual({ authorization: "Bearer fresh-ro" });
    expect(bodies[0]).toEqual({ refresh_token: "rt-ro", profile: "read-only" });
    const persisted = JSON.parse(readFileSync(env.HUBSPOT_TOKEN_STORE_PATH!, "utf8")) as TokenStore;
    expect(persisted.profile).toBe("read-only");
    expect(persisted.scopes).toEqual(["oauth", "conversations.read"]);
  });

  it("adopts a replaced on-disk store instead of clobbering it with the stale grant", async () => {
    // The provider starts from a read+write grant…
    const stale: TokenStore = {
      version: 1,
      brokerUrl: "https://broker.test",
      accessToken: "old-rw",
      refreshToken: "rt-old",
      expiresAt: Date.now() - 1000,
      scopes: ["oauth", "conversations.read", "conversations.write"],
    };
    // …but the user re-logged in read-only while the server was running.
    const relogin: TokenStore = {
      version: 1,
      brokerUrl: "https://broker.test",
      accessToken: "new-ro",
      refreshToken: "rt-new",
      expiresAt: Date.now() + 3600_000,
      scopes: ["oauth", "conversations.read"],
    };
    writeTokenStore(relogin, env);

    const fetchStub = (async () => {
      throw new Error("must not refresh the stale grant");
    }) as typeof fetch;

    const provider = new OAuthTokenProvider(stale, fetchStub, env);
    expect(await provider.getAuthHeaders()).toEqual({ authorization: "Bearer new-ro" });
    const persisted = JSON.parse(readFileSync(env.HUBSPOT_TOKEN_STORE_PATH!, "utf8")) as TokenStore;
    expect(persisted.refreshToken).toBe("rt-new");
    expect(persisted.scopes).toEqual(["oauth", "conversations.read"]);
  });
});

describe("HubSpotClient 401 retry", () => {
  const config: HubSpotConfig = {
    baseUrl: "https://api.hubapi.com",
    apiVersion: "2026-09-beta",
    customChannelsApiVersion: "2026-03",
  };

  it("force-refreshes once on 401 and retries with the new token", async () => {
    let token = "old";
    const provider: TokenProvider = {
      getAuthHeaders: async () => ({ authorization: `Bearer ${token}` }),
      refreshAfterUnauthorized: async () => {
        token = "new";
        return true;
      },
    };
    const seenAuth: string[] = [];
    const fetchStub = (async (_url: string | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      seenAuth.push(auth);
      if (auth === "Bearer old") return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ id: "1" }), { status: 200 });
    }) as typeof fetch;

    const client = new HubSpotClient(config, fetchStub, provider);
    const result = await client.request<{ id: string }>("GET", "/threads/1");
    expect(result.id).toBe("1");
    expect(seenAuth).toEqual(["Bearer old", "Bearer new"]);
  });

  it("rejects construction without a token provider", () => {
    expect(() => new HubSpotClient(config)).toThrow(/login/);
  });
});
