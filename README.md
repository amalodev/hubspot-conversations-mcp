# hubspot-conversations-mcp

[![CI](https://github.com/amalodev/hubspot-conversations-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/amalodev/hubspot-conversations-mcp/actions/workflows/ci.yml)

MCP server for the [HubSpot Conversations API](https://developers.hubspot.com/docs/api/conversations/conversations) with **1:1 tool parity with the [Arcade.dev HubSpot Conversations API toolkit](https://docs.arcade.dev/en/resources/integrations/sales/hubspot-conversations-api)** (24 tools). Read conversation threads and messages, send replies, manage threads and channel accounts, and integrate custom channels — from any MCP client (Claude Code, Claude Desktop, etc.).

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

1. **Token guide** — step-by-step instructions for creating a [HubSpot service key](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys) (**Development → Keys → Service Keys**) with the right scopes: `conversations.read`, `conversations.write`, and optionally `conversations.custom_channels.read`/`.write` for the custom-channel tools.
2. **Token prompt** — paste the `pat-...` service key (input is masked; legacy private app tokens and OAuth2 access tokens also work), plus an optional default sender actor ID for replies.
3. **Agent selection** — choose which AI agents to configure: **Claude Desktop**, **Claude Code**, and/or **Hermes** ([Nous Research hermes-agent](https://hermes-agent.nousresearch.com)).
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
| `HUBSPOT_ACCESS_TOKEN` | ✅ | Service key (`pat-...`), legacy private app token, or OAuth2 access token |
| `HUBSPOT_DEFAULT_SENDER_ACTOR_ID` | | Default sender for `SendConversationMessage`, e.g. `A-12345` (agent actor = `A-<hubspot user id>`) |
| `HUBSPOT_BASE_URL` | | Default `https://api.hubapi.com` |
| `HUBSPOT_CONVERSATIONS_API_VERSION` | | Default `2026-09-beta` — update here when the API graduates from beta |
| `HUBSPOT_CUSTOM_CHANNELS_API_VERSION` | | Default `2026-03` |
| `HUBSPOT_AUTH_MODE` | | `bearer` (default — works for service keys, legacy tokens and OAuth2) or `private-app` for the legacy header |

## Tools (Arcade parity)

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

Pass any of them explicitly to override. Arcade-style calls are also supported: pass a stringified JSON `request_body` (typed fields win on conflict), and call with `mode="get_request_schema"` to inspect the raw body schema. The same pattern applies to `PublishCustomChannelMessage`.

## Development

```bash
npm test           # vitest — unit + in-memory MCP integration tests
npm run typecheck  # tsc --noEmit
npm run build      # compile to dist/
npm run bundle     # build a .mcpb one-click bundle for Claude Desktop
```

The integration tests run the full MCP server against a stubbed `fetch`, so no HubSpot account is needed to develop.

## Notes

- Tool names and parameters mirror Arcade's `HubspotConversationsApi` toolkit 1:1; list tools additionally accept optional filter/pagination parameters (supersets of Arcade's schemas).
- The client retries once on `429`/`502`/`503`, honoring `Retry-After` (capped at 10s).
- Thread assignee endpoints (`PUT`/`DELETE /threads/{id}/assignee`) exist in the HubSpot API but are not part of Arcade's toolkit, so they are not exposed as tools. Re-add them in `src/tools/threads.ts` if needed.
