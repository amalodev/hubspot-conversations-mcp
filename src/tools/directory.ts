import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HubSpotClient } from "../client.js";
import { runTool } from "../format.js";

export function registerDirectoryTools(server: McpServer, client: HubSpotClient): void {
  server.registerTool(
    "ListConversationInboxes",
    {
      title: "List conversation inboxes",
      description:
        "Fetch a list of conversation inboxes (shared inboxes and help desks), with optional " +
        "filters and sorting to customize the results.",
      inputSchema: {
        limit: z.number().int().min(1).optional().describe("Max results per page"),
        after: z.string().optional().describe("Pagination cursor from paging.next.after"),
        is_archived: z.boolean().optional().describe("Set true to list archived inboxes"),
        sort: z.array(z.string()).optional().describe("Fields to sort by"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request("GET", "/inboxes", {
          query: { limit: args.limit, after: args.after, archived: args.is_archived, sort: args.sort },
        }),
      ),
  );

  server.registerTool(
    "GetInboxDetails",
    {
      title: "Get inbox details",
      description: "Retrieve detailed information about a specific conversation inbox by its ID.",
      inputSchema: {
        inbox_id: z
          .string()
          .describe("The unique identifier for the conversation inbox you wish to retrieve details for"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() => client.request("GET", `/inboxes/${encodeURIComponent(args.inbox_id)}`)),
  );

  server.registerTool(
    "ListConversationChannels",
    {
      title: "List conversation channels",
      description:
        "Retrieve a list of conversation channels (e.g. email, live chat, forms, WhatsApp), with " +
        "optional filters and sorting if needed.",
      inputSchema: {
        limit: z.number().int().min(1).optional().describe("Max results per page"),
        after: z.string().optional().describe("Pagination cursor from paging.next.after"),
        sort: z.array(z.string()).optional().describe("Fields to sort by"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request("GET", "/channels", {
          query: { limit: args.limit, after: args.after, sort: args.sort },
        }),
      ),
  );

  server.registerTool(
    "RetrieveChannelDetails",
    {
      title: "Retrieve channel details",
      description:
        "Retrieve comprehensive details about a specific channel in HubSpot Conversations by " +
        "providing the channel ID.",
      inputSchema: {
        channel_id: z.string().describe("The unique ID of the channel to retrieve details for"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() => client.request("GET", `/channels/${encodeURIComponent(args.channel_id)}`)),
  );

  server.registerTool(
    "RetrieveChannelAccounts",
    {
      title: "Retrieve channel accounts",
      description:
        "Retrieve a list of channel accounts — concrete instances of a channel connected to an " +
        "inbox (e.g. a specific email address or phone number). Supports optional filters and " +
        "sorting to refine the results.",
      inputSchema: {
        channel_id: z.array(z.string()).optional().describe("Filter by channel IDs"),
        inbox_id: z.array(z.string()).optional().describe("Filter by inbox IDs"),
        is_archived: z.boolean().optional().describe("Set true to list archived channel accounts"),
        limit: z.number().int().min(1).optional().describe("Max results per page"),
        after: z.string().optional().describe("Pagination cursor from paging.next.after"),
        sort: z.array(z.string()).optional().describe("Fields to sort by"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request("GET", "/channel-accounts", {
          query: {
            channelId: args.channel_id,
            inboxId: args.inbox_id,
            archived: args.is_archived,
            limit: args.limit,
            after: args.after,
            sort: args.sort,
          },
        }),
      ),
  );

  server.registerTool(
    "GetChannelAccountDetails",
    {
      title: "Get channel account details",
      description:
        "Fetch detailed information about a specific HubSpot channel account using the channel " +
        "account ID, such as its status and configuration.",
      inputSchema: {
        channel_account_id: z
          .string()
          .describe("The unique ID of the HubSpot channel account to retrieve details for"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request("GET", `/channel-accounts/${encodeURIComponent(args.channel_account_id)}`),
      ),
  );

  server.registerTool(
    "RetrieveActorDetails",
    {
      title: "Retrieve actor details",
      description:
        "Retrieve details of a specific actor (conversation participant) by actor ID. Actor IDs " +
        "are prefixed by type: 'A-' agent/user, 'V-' visitor/contact, 'B-' bot, 'E-' email, " +
        "'S-' system, 'I-' integrator.",
      inputSchema: {
        actor_id: z
          .string()
          .describe("The unique identifier for the actor whose details are to be retrieved, e.g. 'A-12345'"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() => client.request("GET", `/actors/${encodeURIComponent(args.actor_id)}`)),
  );

  server.registerTool(
    "ResolveConversationActors",
    {
      title: "Resolve conversation actors",
      description:
        "Resolve a list of ActorIds to detailed participant information in one batch call — use " +
        "this to understand who the participants in a conversation are.",
      inputSchema: {
        actor_ids: z
          .array(z.string())
          .min(1)
          .describe("A list of Actor IDs to resolve, e.g. ['A-12345', 'V-67890']"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request("POST", "/actors/batch/read", { body: { inputs: args.actor_ids } }),
      ),
  );
}
