# hubspot-conversations-mcp

[![CI](https://github.com/amalodev/hubspot-conversations-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/amalodev/hubspot-conversations-mcp/actions/workflows/ci.yml)

MCP server for the [HubSpot Conversations API](https://developers.hubspot.com/docs/api/conversations/conversations) — 24 tools to read conversation threads and messages, send replies, manage threads and channel accounts, and integrate custom channels, from any MCP client (Claude Code, Claude Desktop, Hermes, etc.).

Covers two HubSpot API surfaces:

- **Conversations API** (`/conversations/conversations/2026-09-beta`) — threads, messages, inboxes, channels, actors
- **Custom Channels API** (`/conversations/custom-channels/2026-03`) — channel accounts, staging tokens, publishing external messages, delivery status

## How authentication works

There is exactly one way to authenticate: **per-user OAuth via your organization's broker**.

Every user signs in with their own HubSpot login — tokens are issued individually, stored only on their machine (`~/.hubspot-conversations-mcp/tokens.json`, 0600), revocable per user, and die when the user is deactivated in HubSpot. No shared credentials exist anywhere.

The broker is a small **stateless service your org hosts** (free on Vercel, [api/](api/) in this repo). It is the only place your HubSpot app's client secret lives; it exchanges authorization codes and refreshes tokens, stores nothing, and never sees Conversations data — **all API traffic goes directly from the user's machine to HubSpot**.

## Org setup (one-time, ~10 minutes)

1. **Create a HubSpot app** (in a [developer account](https://developers.hubspot.com), e.g. as a developer-projects app): use `"distribution": "private"` and allowlist your portal. The `auth` block of `app-hsmeta.json` should look like:

   ```json
   "auth": {
     "type": "oauth",
     "redirectUrls": ["http://localhost:4573/callback"],
     "requiredScopes": ["oauth", "conversations.read"],
     "optionalScopes": ["conversations.write"],
     "conditionallyRequiredScopes": []
   }
   ```

   `conversations.write` is **optional**, matching how the CLI requests it: the default
   `login` sends `conversations.read` in the authorize URL's `scope` parameter and
   `conversations.write` in `optional_scope` — HubSpot rejects the consent screen
   whenever that split does not match the app's configuration — except the `oauth`
   scope, which HubSpot grants automatically without it being requested. (Optional
   scopes are granted automatically when the portal supports them; a read-only sign-in
   means not requesting write at all — see below.) If your org uses custom
   channels, add `conversations.custom_channels.read` /
   `conversations.custom_channels.write` to `optionalScopes` as well and request them at
   login via `--optional-scopes`.

   **If you want read-only tokens** (some agents may read conversations but never send,
   update or archive), create a **second app** with only the read scope — see
   [Read-only vs read + write](#read-only-vs-read--write) for why one app can't do both:

   ```json
   "auth": {
     "type": "oauth",
     "redirectUrls": ["http://localhost:4573/callback"],
     "requiredScopes": ["oauth", "conversations.read"],
     "optionalScopes": [],
     "conditionallyRequiredScopes": []
   }
   ```

   Both apps live behind the **same broker** — the read-only app's credentials go in a
   second pair of env vars (next step), and `login --read-only` selects it.

   **Apps created from the pre-0.11 template** (where `conversations.write` sat in
   `requiredScopes`): either move it to `optionalScopes` as above (users re-authorize on
   their next login), or keep it required and have users sign in with
   `login --scopes conversations.read,conversations.write` — read-only sign-ins are not
   possible with that configuration.

   Deploy the app and note the client ID and client secret from its Auth tab.

2. **Deploy the broker to Vercel** — one click:

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Famalodev%2Fhubspot-conversations-mcp&env=HUBSPOT_OAUTH_CLIENT_ID,HUBSPOT_OAUTH_CLIENT_SECRET&envDescription=Client%20ID%20and%20secret%20from%20your%20HubSpot%20app%27s%20Auth%20tab&project-name=hubspot-conversations-broker&repository-name=hubspot-conversations-broker)

   The button clones this repo and prompts for the two environment variables (`HUBSPOT_OAUTH_CLIENT_ID`, `HUBSPOT_OAUTH_CLIENT_SECRET`). Alternatively create the Vercel project manually from your fork, or wire up CI deploys via [deploy-broker.yml](.github/workflows/deploy-broker.yml) with the `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` repo secrets.

   One deployment can front **both apps**:

   | Env var | App |
   |---|---|
   | `HUBSPOT_OAUTH_CLIENT_ID` / `HUBSPOT_OAUTH_CLIENT_SECRET` | read + write (default) |
   | `HUBSPOT_OAUTH_READ_ONLY_CLIENT_ID` / `HUBSPOT_OAUTH_READ_ONLY_CLIENT_SECRET` | read-only (optional) |

   The client's `login --read-only` selects the read-only app, and the choice travels
   with the tokens so refreshes use the right app's credentials. The broker's
   `/api/config` advertises which apps exist and their scopes, so `login` and `setup`
   request exactly the right split automatically. Optional fine-tuning:
   `HUBSPOT_OAUTH_SCOPES` / `HUBSPOT_OAUTH_OPTIONAL_SCOPES` override what the default
   app's logins request (e.g. to add custom-channel scopes), and
   `HUBSPOT_OAUTH_READ_ONLY_SCOPES` / `HUBSPOT_OAUTH_READ_ONLY_OPTIONAL_SCOPES` do the
   same for the read-only app (default: just `conversations.read`).

3. **Share the broker URL** (e.g. `https://your-broker.vercel.app`) with the team — it is not a secret, and neither is the client ID (the CLI fetches it from the broker's `/api/config`). Setting `HUBSPOT_OAUTH_BROKER_URL` org-wide (dotfiles, MDM, onboarding docs) makes all commands flag-free.

Because the app is private-distribution and allowlisted, only your own org's portals can complete a login against your broker — each org runs its own broker with its own app, so tokens never cross organizational trust boundaries.

## Per user

### Interactive setup (recommended)

```bash
npx -y hubspot-conversations-mcp setup
```

The wizard walks through everything:

1. **Broker** — asks whether your org already has a broker; if not, it shows the setup guide (and links back here). The URL is **verified live** against `/api/config` before continuing.
2. **Sign in** — the wizard asks which access level to sign in with: read & write, or read-only (via the broker's read-only app when it has one, otherwise as a best-effort reduced-scope request). Brokers that advertise a scope profile decide the level themselves and skip the question. Then your browser opens HubSpot's consent screen; sign in with your own HubSpot login. Tokens land on your machine and auto-refresh through the broker.
3. **Agents** — pick which AI agents to configure with an arrow-key multiselect (↑/↓ to move, space to toggle): **Claude Desktop**, **Claude Code**, and/or **Hermes** ([Nous Research hermes-agent](https://hermes-agent.nousresearch.com)). Each is configured automatically — no credentials are written to any config file.

### Manual / scripted

```bash
npx -y hubspot-conversations-mcp login --broker-url https://your-broker.vercel.app
```

```bash
npx -y hubspot-conversations-mcp install --client all
```

`--client` takes `claude-desktop`, `claude-code`, `hermes`, `both` (the two Claude clients), `all`, or a comma-separated combination:

- **claude-desktop** — merges the server into `claude_desktop_config.json` (existing servers preserved; timestamped backup first). Restart Claude Desktop afterwards.
- **claude-code** — runs `claude mcp add … -- npx -y hubspot-conversations-mcp` (prints the command if the `claude` CLI is unavailable). Add `--scope user` to register across all your projects (the setup wizard defaults to this).
- **hermes** — merges the server into `~/.hermes/config.yaml` under `mcp_servers` with `enabled: true` (backup first; YAML comments are not preserved). Verify with `hermes mcp test hubspot-conversations`.

`whoami` shows the active sign-in, `logout` removes it. Use `--dry-run` to preview installs, `--config-path` / `--hermes-config-path` for non-standard config locations.

### Read-only vs read + write

Write access is a property of the **token**, not of the server: the server looks at the
scopes granted at login and only registers the tools that token can actually use. HubSpot
enforces scopes server-side either way — the gating just keeps the tool list honest, so a
read-only sign-in gets a server without `SendConversationMessage`,
`UpdateConversationThread` or `ArchiveConversationThread` instead of tools that fail
with 403.

**One app cannot give the same portal both access levels.** HubSpot grants scopes per
*app installation* on the portal, not per authorization: once an app is connected with
write access, a later login requesting fewer scopes just re-attaches to the existing
grant and returns a token that still carries write (scopes only shrink when they are
removed from the app's auth settings entirely and the user reauthorizes — see HubSpot's
[auth settings](https://developers.hubspot.com/changelog/advanced-auth-and-scope-settings-for-public-apps)
and [reauthorization](https://developers.hubspot.com/changelog/public-app-reauthorization-and-advanced-scope-settings)
changelogs). The server will honestly show that: `whoami` reports `read + write` and the
write tools stay registered, because the token really can write.

**Genuinely read-only tokens therefore come from a second, read-only app** (org setup
above): an app whose only conversations scope is `conversations.read`, registered on the
same broker via `HUBSPOT_OAUTH_READ_ONLY_CLIENT_ID` / `HUBSPOT_OAUTH_READ_ONLY_CLIENT_SECRET`.
`login --read-only` signs in through that app — its tokens can never write, no matter
what is requested — and the profile travels with the stored tokens so refreshes keep
using the right app. Use a separate token store to keep it next to your main sign-in:

```bash
HUBSPOT_TOKEN_STORE_PATH=~/.hubspot-conversations-mcp/tokens-ro.json \
  npx -y hubspot-conversations-mcp login --broker-url https://your-broker.vercel.app --read-only
```

Then register a second MCP entry pointing at that store, e.g. for Claude Code:

```bash
claude mcp add hubspot-conversations-ro --env HUBSPOT_TOKEN_STORE_PATH=$HOME/.hubspot-conversations-mcp/tokens-ro.json -- npx -y hubspot-conversations-mcp
```

The default registration keeps the read + write token; `hubspot-conversations-ro` only
ever sees the 13 read tools — and its token couldn't write even outside MCP.

Details:

- `--read-only` requires the broker to have the read-only app configured (`login` fails with a pointer here otherwise). Without a second app, the wizard's "Read-only (best effort)" choice — or `--scopes conversations.read` — requests a reduced grant from the main app, which yields a truly read-only token **only if the app was never granted write on that portal** (otherwise the existing grant wins, see above).
- When the broker advertises a scope profile for its default app (`HUBSPOT_OAUTH_SCOPES`), plain `login` requests exactly that; a wizard run against such a broker (with no read-only app) shows the resulting access level instead of asking.
- `--scopes` sets the app-*required* scopes and `--optional-scopes` the app-*optional* ones, e.g. `--optional-scopes conversations.write,conversations.custom_channels.read,conversations.custom_channels.write` — custom-channel tools are likewise only offered when the `conversations.custom_channels.*` scopes were granted. HubSpot rejects the consent screen if the split does not match the app's scope configuration.
- The rare token store without recorded scopes (scope introspection failed during a pre-0.11 login) makes the server offer **all** tools, with HubSpot alone enforcing access; since 0.11 `login` always records scopes, falling back to the requested ones. Re-run `login` to fix such a store.
- **Upgrading from 0.10**: tokens signed in with the default scopes never carried `conversations.custom_channels.*`, so the 8 custom-channel tools disappear from the tool list on upgrade — they previously appeared but always failed with 403. Re-login with `--optional-scopes` including those scopes (and the app updated to offer them) to use them.
- `whoami` prints the access level of the active sign-in (from the token's live scopes when reachable).
- The tool list is fixed when the server starts — after changing access level with a re-login, restart the MCP client/server to apply the new gating.

### Broker endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | Public app metadata (client IDs and scope profiles of the configured apps) so users only need the broker URL |
| `POST /api/exchange` | `{code, redirect_uri, profile?}` → tokens; `profile: "read-only"` uses the read-only app; redirect URIs are restricted to localhost |
| `POST /api/refresh` | `{refresh_token, profile?}` → fresh access token from the same app the tokens came from |

### One-click bundle for Claude Desktop (MCPB)

The repo ships a [manifest.json](manifest.json) following Anthropic's [MCP Bundle](https://github.com/anthropics/mcpb) format:

```bash
npm run bundle
```

This produces a `.mcpb` file. Open it with Claude Desktop (or drag it into **Settings → Extensions**) for a one-click install. Run `npx -y hubspot-conversations-mcp login` once first — the extension uses the same per-user sign-in.

## Releasing to npm

Releases ship automatically from `main`. Bump `version` in [package.json](package.json) and [manifest.json](manifest.json) plus `SERVER_VERSION` in [server.ts](src/server.ts) — all three must match — and merge. The [release workflow](.github/workflows/release.yml) spots that the version isn't on npm yet, runs the tests, creates the `v<version>` tag + GitHub release with generated notes, and publishes that release to npm with provenance (auth via the `NPM_TOKEN` repo secret). Pushes without a version bump are no-ops.

`prepublishOnly` builds and runs the full test suite before the actual upload. The published package contains only `dist/`, `manifest.json`, README and LICENSE.

## Configuration

| Environment variable | Description |
|---|---|
| `HUBSPOT_OAUTH_BROKER_URL` | Your org's broker URL, used by `login`/`setup` when `--broker-url` is not passed |
| `HUBSPOT_TOKEN_STORE_PATH` | OAuth token store location (default `~/.hubspot-conversations-mcp/tokens.json`) — set per registration to run e.g. a read-only and a read + write sign-in side by side |
| `HUBSPOT_DEFAULT_SENDER_ACTOR_ID` | Default sender for `SendConversationMessage`, e.g. `A-12345` (agent actor = `A-<hubspot user id>`) |
| `HUBSPOT_BASE_URL` | Default `https://api.hubapi.com` |
| `HUBSPOT_CONVERSATIONS_API_VERSION` | Default `2026-09-beta` — update here when the API graduates from beta |
| `HUBSPOT_CUSTOM_CHANNELS_API_VERSION` | Default `2026-03` |

On the **broker deployment** (never on user machines): `HUBSPOT_OAUTH_CLIENT_ID` / `HUBSPOT_OAUTH_CLIENT_SECRET` (read + write app), optionally `HUBSPOT_OAUTH_READ_ONLY_CLIENT_ID` / `HUBSPOT_OAUTH_READ_ONLY_CLIENT_SECRET` (read-only app used by `login --read-only`), and optionally `HUBSPOT_OAUTH_SCOPES` / `HUBSPOT_OAUTH_OPTIONAL_SCOPES` (+ `_READ_ONLY_` variants) to override the scopes logins request.

## Tools

Tool availability follows the scopes granted at login (see
[Read-only vs read + write](#read-only-vs-read--write)): read tools need
`conversations.read`, write tools need `conversations.write`, and the custom-channel
group needs `conversations.custom_channels.read` / `.write`. Tokens with no recorded
scopes get all 24 tools.

**Threads**

| Tool | Description |
|---|---|
| `RetrieveConversationThreads` | List/search threads — filter by inbox, OPEN/CLOSED, contact, ticket, time window; paginated |
| `RetrieveThreadById` | Get a single thread (status, inbox, channel, assignee, contact) |
| `UpdateConversationThread` | Set OPEN/CLOSED, archive or restore a thread |
| `ArchiveConversationThread` | Soft-delete a thread (permanently deleted after 30 days) |

**Messages**

| Tool | Description |
|---|---|
| `GetMessageHistoryForThread` | Message history of a thread (messages, comments, system events); paginated |
| `RetrieveThreadMessage` | Get a single message |
| `RetrieveFullMessageContent` | Original (untruncated) text/richText of a message |
| `SendConversationMessage` | Send a message to the customer — or an internal comment with `message_type=COMMENT` |

**Inboxes, channels & actors**

| Tool | Description |
|---|---|
| `ListConversationInboxes` / `GetInboxDetails` | Conversation inboxes / help desks |
| `ListConversationChannels` / `RetrieveChannelDetails` | Channel types (email, chat, …) |
| `RetrieveChannelAccounts` / `GetChannelAccountDetails` | Connected accounts (specific email addresses / numbers) |
| `RetrieveActorDetails` / `ResolveConversationActors` | Resolve actor IDs (`A-` agent, `V-` visitor, `B-` bot, `E-` email, `S-` system, `I-` integrator) |

**Custom channels** (offered only when the token carries the `conversations.custom_channels.*` scopes)

| Tool | Description |
|---|---|
| `CreateChannelAccount` | Create an account on a custom channel |
| `GetCustomChannelAccounts` | List accounts on a custom channel |
| `RetrieveChannelAccountDetails` | Get one custom-channel account |
| `UpdateChannelAccountInfo` | Rename or (de)authorize a channel account |
| `UpdateChannelAccountStaging` | Finalize a staging-token connection (public apps) |
| `PublishCustomChannelMessage` | Publish an external message into HubSpot |
| `GetCustomChannelMessageDetails` | Get a custom-channel message |
| `UpdateMessageStatus` | Report delivery status: SENT / FAILED / READ |

### Sending replies

`SendConversationMessage` only *requires* `thread_id` and `text`. Everything else is derived:

- `channel_id` / `channel_account_id` — taken from the thread's `originalChannelId` / `originalChannelAccountId`
- `recipients` — the senders of the latest **incoming** message (i.e. a normal reply)
- `sender_actor_id` — falls back to `HUBSPOT_DEFAULT_SENDER_ACTOR_ID`

Pass any of them explicitly to override. The full request body can also be supplied as a stringified JSON `request_body` (typed fields win on conflict), and calling with `mode="get_request_schema"` returns the raw body schema. The same pattern applies to `PublishCustomChannelMessage`.

## Development

```bash
npm test           # vitest — unit + in-memory MCP integration tests
npm run typecheck  # tsc --noEmit (CLI + broker functions)
npm run build      # compile to dist/
npm run bundle     # build a .mcpb one-click bundle for Claude Desktop
```

The integration tests run the full MCP server against a stubbed `fetch`, so no HubSpot account is needed to develop.

## Notes

- The client retries once on `429`/`502`/`503` (honoring `Retry-After`, capped at 10s) and once more with a refreshed token on `401`.
- Thread assignee endpoints (`PUT`/`DELETE /threads/{id}/assignee`) exist in the HubSpot API but are not currently exposed as tools. Add them in `src/tools/threads.ts` if needed.
