# hubspot-conversations-mcp

[![CI](https://github.com/amalodev/hubspot-conversations-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/amalodev/hubspot-conversations-mcp/actions/workflows/ci.yml)

MCP server for the [HubSpot Conversations API](https://developers.hubspot.com/docs/api/conversations/conversations) — 24 tools to read conversation threads and messages, send replies, manage threads and channel accounts, and integrate custom channels, from any MCP client (Claude Code, Claude Desktop, etc.).

Covers two HubSpot API surfaces:

- **Conversations API** (`/conversations/conversations/2026-09-beta`) — threads, messages, inboxes, channels, actors
- **Custom Channels API** (`/conversations/custom-channels/2026-03`) — channel accounts, staging tokens, publishing external messages, delivery status

## Install

Once published to npm, no clone or build is needed — MCP clients run the server straight off the registry with `npx`.

### Interactive setup (recommended)

```bash
npx -y hubspot-conversations-mcp setup
```

The wizard walks you through everything:

1. **Auth method** — choose between **per-user OAuth** (each user signs in with their own HubSpot login via your org's broker — see [Per-user OAuth](#per-user-oauth-team-setup)) or a **service key**. The service-key path shows step-by-step instructions for creating a [HubSpot service key](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys) (**Development → Keys → Service Keys**) with the right scopes: `conversations.read`, `conversations.write`, and optionally `conversations.custom_channels.read`/`.write` for the custom-channel tools.
2. **Credentials** — either the masked service-key prompt, or the browser-based HubSpot sign-in; plus an optional default sender actor ID for replies.
3. **Agent selection** — pick which AI agents to configure with an arrow-key multiselect (↑/↓ to move, space to toggle): **Claude Desktop**, **Claude Code**, and/or **Hermes** ([Nous Research hermes-agent](https://hermes-agent.nousresearch.com)).
4. **Automatic install** — each selected agent is configured immediately.

The wizard also works scripted: pipe the answers via stdin (`printf 'pat-...\n\n1,3\n' | npx -y hubspot-conversations-mcp setup`).

### Non-interactive install

```bash
npx -y hubspot-conversations-mcp install --client all --token pat-eu1-... --sender-actor-id A-12345
```

`--client` takes `claude-desktop`, `claude-code`, `hermes`, `both` (the two Claude clients), `all`, or a comma-separated combination:

- **claude-desktop** — merges the server into `claude_desktop_config.json` (existing servers and settings are preserved; a timestamped backup is written first). Restart Claude Desktop afterwards.
- **claude-code** — runs `claude mcp add … -- npx -y hubspot-conversations-mcp` for you (prints the command if the `claude` CLI is unavailable). Add `--scope user` to register it across all your projects (the setup wizard defaults to this).
- **hermes** — merges the server into `~/.hermes/config.yaml` under `mcp_servers` with `enabled: true` (backup written first; note that YAML comments are not preserved). Verify with `hermes mcp test hubspot-conversations`.

Use `--dry-run` to preview changes without writing anything, `--config-path` for a non-standard Claude Desktop config location, and `--hermes-config-path` (or `HERMES_CONFIG_PATH`) for a non-standard Hermes config location.

> **Note on tokens:** HubSpot service keys can only be created in the HubSpot UI — there is no public API to generate them, so the CLI guides you through it instead of doing it for you. Service keys replaced private apps (now "Legacy Apps") as HubSpot's recommended credential for single-account integrations; legacy private app tokens keep working.

### Manual: Claude Code

```bash
claude mcp add hubspot-conversations --env HUBSPOT_ACCESS_TOKEN=pat-eu1-... --env HUBSPOT_DEFAULT_SENDER_ACTOR_ID=A-12345 -- npx -y hubspot-conversations-mcp
```

### Manual: Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hubspot-conversations": {
      "command": "npx",
      "args": ["-y", "hubspot-conversations-mcp"],
      "env": {
        "HUBSPOT_ACCESS_TOKEN": "pat-eu1-...",
        "HUBSPOT_DEFAULT_SENDER_ACTOR_ID": "A-12345"
      }
    }
  }
}
```

### Prerequisite reminder: HubSpot scopes

The service key (or legacy private app token / OAuth2 app) must have `conversations.read` + `conversations.write`, and `conversations.custom_channels.read`/`.write` if you use the custom-channel tools. Note that service keys support REST API calls only — not webhooks — which is all this server needs.

## Per-user OAuth (team setup)

Instead of sharing one service key across the team, each user can sign in with their **own HubSpot login**. Their tokens are issued individually, stored only on their machine, revocable per user, and die when the user is deactivated in HubSpot.

The repo ships a **stateless OAuth broker** ([api/](api/)) — the only place the HubSpot app's client secret lives. It exchanges authorization codes and refreshes tokens, stores nothing, and sees no Conversations data: **all API traffic still goes directly from the user's machine to HubSpot**.

### One-time org setup

1. **Create a HubSpot app** (in a [developer account](https://developers.hubspot.com)): a public app with `"distribution": "private"`, allowlist your portal, redirect URL `http://localhost:4573/callback`, and the scopes `conversations.read` + `conversations.write` (plus `conversations.custom_channels.*` if needed). Note the client ID and client secret.
2. **Deploy the broker to Vercel**: create a Vercel project from this repo and set two environment variables on it: `HUBSPOT_OAUTH_CLIENT_ID` and `HUBSPOT_OAUTH_CLIENT_SECRET`. Continuous deploys run via [deploy-broker.yml](.github/workflows/deploy-broker.yml) — add the repo secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` (from the Vercel project's settings), and every change to `api/**` on `main` deploys automatically (the workflow skips with a notice until the secrets exist).
3. Share the broker URL (e.g. `https://your-broker.vercel.app`) with the team — it is not a secret, and neither is the client ID (the CLI fetches it from the broker's `/api/config`).

### Per user

```bash
npx -y hubspot-conversations-mcp login
```

The default broker is `https://hubspot-conversations-mcp.vercel.app`. Its HubSpot app is private-distribution and allowlisted, so only approved portals can complete a login — other orgs deploy their own broker (step 2 above) and pass `--broker-url` / set `HUBSPOT_OAUTH_BROKER_URL`.

The browser opens for the HubSpot consent screen; tokens are stored in `~/.hubspot-conversations-mcp/tokens.json` (0600) and auto-refreshed through the broker. Then register the server without any token:

```bash
npx -y hubspot-conversations-mcp install --client all --oauth
```

…or run `setup` and pick "Log in with HubSpot". `whoami` shows the active credentials, `logout` removes them. `HUBSPOT_ACCESS_TOKEN` always takes precedence when set, so CI/automation keeps using a service key.

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

This produces a `.mcpb` file. Open it with Claude Desktop (or drag it into **Settings → Extensions**) for a one-click install — the token is collected in the UI and stored in the OS keychain instead of a config file.

## Publishing to npm

```bash
npm publish
```

`prepublishOnly` builds and runs the full test suite first. The published package contains only `dist/`, `manifest.json`, README and LICENSE. Bump `version` in both [package.json](package.json) and [manifest.json](manifest.json) (and `SERVER_VERSION` in [server.ts](src/server.ts)) per release.

## Configuration

| Environment variable | Required | Description |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | (✅) | Service key (`pat-...`), legacy private app token, or OAuth2 access token. Optional when a per-user OAuth login exists on the machine; takes precedence when both are present |
| `HUBSPOT_OAUTH_BROKER_URL` | | Broker URL for the `login` command (default `https://hubspot-conversations-mcp.vercel.app`) |
| `HUBSPOT_TOKEN_STORE_PATH` | | OAuth token store location (default `~/.hubspot-conversations-mcp/tokens.json`) |
| `HUBSPOT_DEFAULT_SENDER_ACTOR_ID` | | Default sender for `SendConversationMessage`, e.g. `A-12345` (agent actor = `A-<hubspot user id>`) |
| `HUBSPOT_BASE_URL` | | Default `https://api.hubapi.com` |
| `HUBSPOT_CONVERSATIONS_API_VERSION` | | Default `2026-09-beta` — update here when the API graduates from beta |
| `HUBSPOT_CUSTOM_CHANNELS_API_VERSION` | | Default `2026-03` |
| `HUBSPOT_AUTH_MODE` | | `bearer` (default — works for service keys, legacy tokens and OAuth2) or `private-app` for the legacy header |

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

**Custom channels** (requires the `conversations.custom_channels.*` scopes)

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
npm run typecheck  # tsc --noEmit
npm run build      # compile to dist/
npm run bundle     # build a .mcpb one-click bundle for Claude Desktop
```

The integration tests run the full MCP server against a stubbed `fetch`, so no HubSpot account is needed to develop.

## Notes

- The client retries once on `429`/`502`/`503`, honoring `Retry-After` (capped at 10s).
- Thread assignee endpoints (`PUT`/`DELETE /threads/{id}/assignee`) exist in the HubSpot API but are not currently exposed as tools. Add them in `src/tools/threads.ts` if needed.
