import type { AuthMode, HubSpotConfig } from "./config.js";

export class HubSpotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly category?: string,
    readonly correlationId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HubSpotApiError";
  }
}

/**
 * Supplies auth headers for API requests. Static providers wrap a fixed
 * service key; the OAuth provider refreshes tokens via the org's broker.
 */
export interface TokenProvider {
  getAuthHeaders(): Promise<Record<string, string>>;
  /** Called after a 401; returns true when the request should be retried. */
  refreshAfterUnauthorized?(): Promise<boolean>;
}

export class StaticTokenProvider implements TokenProvider {
  constructor(
    private readonly accessToken: string,
    private readonly authMode: AuthMode,
  ) {}

  async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.authMode === "private-app") {
      return { "private-app": this.accessToken };
    }
    return { authorization: `Bearer ${this.accessToken}` };
  }
}

export type QueryParams = Record<
  string,
  string | number | boolean | Array<string | number> | undefined
>;

export function buildQuery(params: QueryParams = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

const RETRYABLE_STATUSES = new Set([429, 502, 503]);
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * Which HubSpot API surface a request targets:
 * - "conversations":   /conversations/conversations/{apiVersion}
 * - "customChannels":  /conversations/custom-channels/{customChannelsApiVersion}
 */
export type ApiRoot = "conversations" | "customChannels";

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  root?: ApiRoot;
}

export class HubSpotClient {
  private readonly provider: TokenProvider;

  constructor(
    private readonly config: HubSpotConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    provider?: TokenProvider,
  ) {
    if (provider) {
      this.provider = provider;
    } else if (config.accessToken) {
      this.provider = new StaticTokenProvider(config.accessToken, config.authMode);
    } else {
      throw new Error(
        "No HubSpot credentials: set HUBSPOT_ACCESS_TOKEN or run `hubspot-conversations-mcp login`.",
      );
    }
  }

  private rootPrefix(root: ApiRoot): string {
    if (root === "customChannels") {
      return `/conversations/custom-channels/${this.config.customChannelsApiVersion}`;
    }
    return `/conversations/conversations/${this.config.apiVersion}`;
  }

  private async send(method: string, url: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(await this.provider.getAuthHeaders()),
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response = await this.fetchImpl(url, init);
    if (RETRYABLE_STATUSES.has(response.status)) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const delayMs = Math.min(
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : 1000,
        MAX_RETRY_DELAY_MS,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      response = await this.fetchImpl(url, init);
    }
    return response;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url =
      `${this.config.baseUrl}${this.rootPrefix(options.root ?? "conversations")}` +
      `${path}${buildQuery(options.query)}`;

    let response = await this.send(method, url, options.body);
    if (response.status === 401 && this.provider.refreshAfterUnauthorized) {
      const shouldRetry = await this.provider.refreshAfterUnauthorized();
      if (shouldRetry) response = await this.send(method, url, options.body);
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }

    if (!response.ok) {
      const err = (typeof data === "object" && data !== null ? data : {}) as Record<
        string,
        unknown
      >;
      throw new HubSpotApiError(
        typeof err.message === "string"
          ? err.message
          : `HubSpot API request failed with status ${response.status}`,
        response.status,
        typeof err.category === "string" ? err.category : undefined,
        typeof err.correlationId === "string" ? err.correlationId : undefined,
        data,
      );
    }
    return data as T;
  }
}
