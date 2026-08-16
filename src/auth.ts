import type { TokenProvider } from "./client.js";
import { readTokenStore, refreshViaBroker, type TokenStore } from "./oauth.js";

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
    this.refreshing ??= this.refreshCurrentGrant().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshCurrentGrant(): Promise<TokenStore> {
    // The store on disk may have been replaced since this process started
    // (e.g. a `login --read-only` re-login). Adopt it instead of refreshing
    // our stale grant, which would clobber the new sign-in's tokens and
    // scopes on disk.
    const disk = readTokenStore(this.env);
    if (disk && disk.refreshToken !== this.store.refreshToken) {
      this.store = disk;
      if (Date.now() < disk.expiresAt - EXPIRY_MARGIN_MS) return disk;
    }
    const updated = await refreshViaBroker(this.store, this.fetchImpl, this.env);
    this.store = updated;
    return updated;
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
