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
     "requiredScopes": ["oauth", "conversations.read", "conversations.write"],
     "optionalScopes": [],
     "conditionallyRequiredScopes": []
   }
   ```

   Deploy the app and note the client ID and client secret from its Auth tab.

2. **Deploy the broker to Vercel** — one click:

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Famalodev%2Fhubspot-conversations-mcp&env=HUBSPOT_OAUTH_CLIENT_ID,HUBSPOT_OAUTH_CLIENT_SECRET&envDescription=Client%20ID%20and%20secret%20from%20your%20HubSpot%20app%27s%20Auth%20tab&project-name=hubspot-conversations-broker&repository-name=hubspot-conversations-broker)

   The button clones this repo and prompts for the two environment variables (`HUBSPOT_OAUTH_CLIENT_ID`, `HUBSPOT_OAUTH_CLIENT_SECRET`). Alternatively create the Vercel project manually from your fork, or wire up CI deploys via [deploy-broker.yml](.github/workflows/deploy-broker.yml) with the `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` repo secrets.

3. **Share the broker URL** (e.g. `https://your-broker.vercel.app`) with the team — it is not a secret, and neither is the client ID (the CLI fetches it from the broker's `/api/config`). Setting `HUBSPOT_OAUTH_BROKER_URL` org-wide (dotfiles, MDM, onboarding docs) makes all commands flag-free.

Because the app is private-distribution and allowlisted, only your own org's portals can complete a login against your broker — each org runs its own broker with its own app, so tokens never cross organizational trust boundaries.

## Per user

### Interactive setup (recommended)

```bash
npx -y hubspot-conversations-mcp setup
```

The wizard walks through everything:

1. **Broker** — asks whether your org already has a broker; if not, it shows the setup guide (and links back here). The URL is **verified live** against `/api/config` before continuing.
2. **Sign in** — your browser opens HubSpot's consent screen; sign in with your own HubSpot login. Tokens land on your machine and auto-refresh through the broker.
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

### Broker endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | Public app metadata (client ID) so users only need the broker URL |
| `POST /api/exchange` | `{code, redirect_uri}` → tokens; redirect URIs are restricted to localhost |
| `POST /api/refresh` | `{refresh_token}` → fresh access token |

### One-click bundle for Claude Desktop (MCPB)

The repo ships a [manifest.json](manifest.json) following Anthropic's [MCP Bundle](https://github.com/anthropics/mcpb) format:

```bash
npm run bundle
```

This produces a `.mcpb` file. Open it with Claude Desktop (or drag it into **Settings → Extensions**) for a one-click install. Run `npx -y hubspot-conversations-mcp login` once first — the extension uses the same per-user sign-in.

## Publishing to npm

```bash
npm publish
```

`prepublishOnly` builds and runs the full test suite first. The published package contains only `dist/`, `manifest.json`, README and LICENSE. Bump `version` in both [package.json](package.json) and [manifest.json](manifest.json) (and `SERVER_VERSION` in [server.ts](src/server.ts)) per release.

## Configuration

| Environment variable | Description |
|---|---|
| `HUBSPOT_OAUTH_BROKER_URL` | Your org's broker URL, used by `login`/`setup` when `--broker-url` is not passed |
| `HUBSPOT_TOKEN_STORE_PATH` | OAuth token store location (default `~/.hubspot-conversations-mcp/tokens.json`) |
| `HUBSPOT_DEFAULT_SENDER_ACTOR_ID` | Default sender for `SendConversationMessage`, e.g. `A-12345` (agent actor = `A-<hubspot user id>`) |
| `HUBSPOT_BASE_URL` | Default `https://api.hubapi.com` |
| `HUBSPOT_CONVERSATIONS_API_VERSION` | Default `2026-09-beta` — update here when the API graduates from beta |
| `HUBSPOT_CUSTOM_CHANNELS_API_VERSION` | Default `2026-03` |

On the **broker deployment** (never on user machines): `HUBSPOT_OAUTH_CLIENT_ID` and `HUBSPOT_OAUTH_CLIENT_SECRET`.

## Tools

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

**Custom channels** (requires the `conversations.custom_channels.*` scopes on the HubSpot app)

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
