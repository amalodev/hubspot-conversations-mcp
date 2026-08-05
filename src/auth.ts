import type { TokenProvider } from "./client.js";
import { refreshViaBroker, type TokenStore } from "./oauth.js";

/** Refresh the access token this many ms before it actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * TokenProvider backed by the local OAuth token store. Access tokens are
 * refreshed through the org's broker just before expiry, and once more on an
 * unexpected 401 (e.g. token revoked server-side). Refreshes are
 * single-flighted so concurrent tool calls share one refresh request.
 */
export class OAuthTokenProvider implements TokenProvider {
  private refreshing?: Promise<TokenStore>;

  constructor(
    private store: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private refresh(): Promise<TokenStore> {
    this.refreshing ??= refreshViaBroker(this.store, this.fetchImpl, this.env)
      .then((updated) => {
        this.store = updated;
        return updated;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    if (Date.now() >= this.store.expiresAt - EXPIRY_MARGIN_MS) {
      await this.refresh();
    }
    return { authorization: `Bearer ${this.store.accessToken}` };
  }

  async refreshAfterUnauthorized(): Promise<boolean> {
    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }
}
