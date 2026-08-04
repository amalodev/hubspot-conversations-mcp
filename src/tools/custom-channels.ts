import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HubSpotClient } from "../client.js";
import { parseRequestBody, runTool } from "../format.js";

const deliveryIdentifierTypeSchema = z
  .enum(["HS_EMAIL_ADDRESS", "HS_PHONE_NUMBER", "CHANNEL_SPECIFIC_OPAQUE_ID", "HS_SHORT_CODE"])
  .describe("Type of delivery identifier");

/** Returned by PublishCustomChannelMessage when mode="get_request_schema". */
const PUBLISH_MESSAGE_BODY_SCHEMA = {
  endpoint: "POST /conversations/custom-channels/{customChannelsApiVersion}/{channelId}/messages",
  required: ["channelAccountId", "senders", "recipients"],
  properties: {
    channelAccountId: "The ID of the channel account the message belongs to",
    senders: [
      {
        deliveryIdentifier: { type: "CHANNEL_SPECIFIC_OPAQUE_ID", value: "external-user-id" },
        name: "Optional display name",
        senderActorId: "Optional actor ID",
      },
    ],
    recipients: [
      {
        deliveryIdentifier: { type: "CHANNEL_SPECIFIC_OPAQUE_ID", value: "external-recipient-id" },
        name: "Optional display name",
      },
    ],
    text: "Plain text content (optional)",
    richText: "Rich text/HTML content (optional)",
    timestamp: "ISO 8601 timestamp of the message (optional)",
    integrationThreadId: "Your external conversation/thread ID (optional)",
    integrationIdempotencyId: "Unique ID for idempotency (optional)",
    inReplyToId: "ID of the message this is a reply to (optional)",
    associateWithContactId: "CRM contact ID to associate the message with (optional, integer)",
    attachments: [{ fileId: "<string>", type: "FILE" }],
  },
};

export function registerCustomChannelTools(server: McpServer, client: HubSpotClient): void {
  server.registerTool(
    "CreateChannelAccount",
    {
      title: "Create a channel account (custom channel)",
      description:
        "Create a new account within a specific custom communication channel. Enables multiple " +
        "accounts to communicate over a single channel with different delivery identifiers. " +
        "Requires the conversations.custom_channels.write scope.",
      inputSchema: {
        account_name: z
          .string()
          .describe("The name of the account to be created for the channel"),
        channel_id: z
          .string()
          .describe("The unique identifier for the custom channel where the account will be created"),
        inbox_id: z
          .string()
          .describe("The unique identifier for the inbox where the channel account will be created"),
        is_authorized: z
          .boolean()
          .describe("Whether the account should be authorized. Set to true for authorized accounts"),
        delivery_identifier_type: deliveryIdentifierTypeSchema.optional(),
        delivery_identifier_value: z
          .string()
          .optional()
          .describe("The delivery identifier value: an E.164 phone number, an email address, or a channel-specific ID"),
      },
    },
    async (args) =>
      runTool(() => {
        const body: Record<string, unknown> = {
          name: args.account_name,
          inboxId: args.inbox_id,
          authorized: args.is_authorized,
        };
        if (args.delivery_identifier_type && args.delivery_identifier_value) {
          body.deliveryIdentifier = {
            type: args.delivery_identifier_type,
            value: args.delivery_identifier_value,
          };
        }
        return client.request(
          "POST",
          `/${encodeURIComponent(args.channel_id)}/channel-accounts`,
          { body, root: "customChannels" },
        );
      }),
  );

  server.registerTool(
    "GetCustomChannelAccounts",
    {
      title: "Get custom channel accounts",
      description:
        "Fetch the list of accounts associated with a specific custom channel, identified by the " +
        "channel ID.",
      inputSchema: {
        custom_channel_id: z
          .string()
          .describe("The unique identifier of the custom channel to retrieve accounts for"),
        limit: z.number().int().min(1).optional().describe("Max results per page"),
        after: z.string().optional().describe("Pagination cursor from paging.next.after"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request(
          "GET",
          `/${encodeURIComponent(args.custom_channel_id)}/channel-accounts`,
          { query: { limit: args.limit, after: args.after }, root: "customChannels" },
        ),
      ),
  );

  server.registerTool(
    "RetrieveChannelAccountDetails",
    {
      title: "Retrieve custom channel account details",
      description:
        "Retrieve detailed metadata about a channel account on a custom channel, including its " +
        "channel, inbox ID, and delivery identifiers.",
      inputSchema: {
        channel_identifier: z.string().describe("The unique identifier for the custom channel"),
        channel_account_id: z
          .string()
          .describe("Unique identifier for the specific channel account to retrieve details about"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request(
          "GET",
          `/${encodeURIComponent(args.channel_identifier)}/channel-accounts/${encodeURIComponent(args.channel_account_id)}`,
          { root: "customChannels" },
        ),
      ),
  );

  server.registerTool(
    "UpdateChannelAccountInfo",
    {
      title: "Update channel account info",
      description:
        "Update the name and/or authorization status of a channel account on a custom channel — " +
        "including disabling the account by setting set_authorization_status to false.",
      inputSchema: {
        channel_id: z.string().describe("The unique identifier for the custom channel"),
        channel_account_id: z
          .string()
          .describe("The unique identifier for the channel account to be updated"),
        channel_account_name: z
          .string()
          .optional()
          .describe("The new display name for the channel account"),
        set_authorization_status: z
          .boolean()
          .optional()
          .describe("New authorization status. Set to false to disable the account"),
      },
    },
    async (args) =>
      runTool(async () => {
        if (
          args.channel_account_name === undefined &&
          args.set_authorization_status === undefined
        ) {
          throw new Error(
            "Provide at least one of `channel_account_name` or `set_authorization_status`.",
          );
        }
        const body: Record<string, unknown> = {};
        if (args.channel_account_name !== undefined) body.name = args.channel_account_name;
        if (args.set_authorization_status !== undefined) {
          body.authorized = args.set_authorization_status;
        }
        return client.request(
          "PATCH",
          `/${encodeURIComponent(args.channel_id)}/channel-accounts/${encodeURIComponent(args.channel_account_id)}`,
          { body, root: "customChannels" },
        );
      }),
  );

  server.registerTool(
    "UpdateChannelAccountStaging",
    {
      title: "Update channel account staging token",
      description:
        "Update the account name and delivery identifier of a channel account staging token " +
        "(public app connection flow) in HubSpot Conversations.",
      inputSchema: {
        channel_id: z.string().describe("The unique identifier for the custom channel"),
        account_token: z
          .string()
          .describe("The staging token identifying the channel account being connected"),
        account_name: z.string().describe("The name of the account to be updated"),
        delivery_identifier_type: deliveryIdentifierTypeSchema,
        delivery_identifier_value: z
          .string()
          .describe("The delivery identifier value: an E.164 phone number, an email address, or a channel-specific ID"),
      },
    },
    async (args) =>
      runTool(() =>
        client.request(
          "PATCH",
          `/${encodeURIComponent(args.channel_id)}/channel-account-staging-tokens/${encodeURIComponent(args.account_token)}`,
          {
            body: {
              accountName: args.account_name,
              deliveryIdentifier: {
                type: args.delivery_identifier_type,
                value: args.delivery_identifier_value,
              },
            },
            root: "customChannels",
          },
        ),
      ),
  );

  server.registerTool(
    "PublishCustomChannelMessage",
    {
      title: "Publish a message to a custom channel",
      description:
        "Publish a message over a specified custom channel into HubSpot Conversations — used by " +
        "custom-integrated messaging channels to sync external messages into HubSpot. Provide the " +
        "message either as typed fields or as a stringified JSON request_body (typed fields win " +
        "on conflict). Requires channelAccountId, senders and recipients. Call with " +
        "mode='get_request_schema' to inspect the raw request body schema.",
      inputSchema: {
        mode: z
          .enum(["get_request_schema", "execute"])
          .optional()
          .describe("'get_request_schema' returns the request body schema; default is 'execute'"),
        custom_channel_id: z
          .string()
          .describe("The unique ID of the custom channel where the message will be published"),
        request_body: z
          .string()
          .optional()
          .describe("Optional stringified JSON request body (see mode='get_request_schema')"),
        channel_account_id: z
          .string()
          .optional()
          .describe("The channel account the message belongs to"),
        text: z.string().optional().describe("Plain text content of the message"),
        rich_text: z.string().optional().describe("Rich text/HTML content"),
        senders: z
          .array(z.record(z.unknown()))
          .optional()
          .describe("Message senders, e.g. [{deliveryIdentifier: {type: 'CHANNEL_SPECIFIC_OPAQUE_ID', value: 'user-1'}, name: 'Name'}]"),
        recipients: z
          .array(z.record(z.unknown()))
          .optional()
          .describe("Message recipients, same shape as senders"),
        timestamp: z.string().optional().describe("ISO 8601 timestamp of the message"),
        integration_thread_id: z
          .string()
          .optional()
          .describe("Your external conversation/thread ID"),
        integration_idempotency_id: z.string().optional().describe("Unique ID for idempotency"),
        in_reply_to_id: z.string().optional().describe("ID of the message this is a reply to"),
        associate_with_contact_id: z
          .number()
          .int()
          .optional()
          .describe("CRM contact ID to associate the message with"),
        attachments: z
          .array(z.record(z.unknown()))
          .optional()
          .describe("Attachments, e.g. [{fileId: '123', type: 'FILE'}]"),
      },
      annotations: { openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        if (args.mode === "get_request_schema") return PUBLISH_MESSAGE_BODY_SCHEMA;

        const body: Record<string, unknown> = parseRequestBody(args.request_body);
        if (args.channel_account_id !== undefined) body.channelAccountId = args.channel_account_id;
        if (args.text !== undefined) body.text = args.text;
        if (args.rich_text !== undefined) body.richText = args.rich_text;
        if (args.senders !== undefined) body.senders = args.senders;
        if (args.recipients !== undefined) body.recipients = args.recipients;
        if (args.timestamp !== undefined) body.timestamp = args.timestamp;
        if (args.integration_thread_id !== undefined) {
          body.integrationThreadId = args.integration_thread_id;
        }
        if (args.integration_idempotency_id !== undefined) {
          body.integrationIdempotencyId = args.integration_idempotency_id;
        }
        if (args.in_reply_to_id !== undefined) body.inReplyToId = args.in_reply_to_id;
        if (args.associate_with_contact_id !== undefined) {
          body.associateWithContactId = args.associate_with_contact_id;
        }
        if (args.attachments !== undefined) body.attachments = args.attachments;

        const missing = ["channelAccountId", "senders", "recipients"].filter(
          (field) =>
            body[field] === undefined ||
            (Array.isArray(body[field]) && (body[field] as unknown[]).length === 0),
        );
        if (missing.length > 0) {
          throw new Error(
            `Missing required fields for publishing: ${missing.join(", ")}. ` +
              "Call with mode='get_request_schema' to see the full request body schema.",
          );
        }

        return client.request(
          "POST",
          `/${encodeURIComponent(args.custom_channel_id)}/messages`,
          { body, root: "customChannels" },
        );
      }),
  );

  server.registerTool(
    "GetCustomChannelMessageDetails",
    {
      title: "Get custom channel message details",
      description:
        "Get the details of a specific message sent through a custom channel — message content, " +
        "sender information, and timestamps.",
      inputSchema: {
        channel_id: z
          .string()
          .describe("The unique identifier for the custom channel the message was sent through"),
        message_id: z
          .string()
          .describe("The unique identifier of the message to retrieve details for"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request(
          "GET",
          `/${encodeURIComponent(args.channel_id)}/messages/${encodeURIComponent(args.message_id)}`,
          { root: "customChannels" },
        ),
      ),
  );

  server.registerTool(
    "UpdateMessageStatus",
    {
      title: "Update custom channel message status",
      description:
        "Update the delivery status of a message within a custom channel: SENT, FAILED, or READ. " +
        "For FAILED messages, include an error message for clarification.",
      inputSchema: {
        channel_identifier: z
          .string()
          .describe("The unique identifier for the custom channel where the message is located"),
        message_id: z.string().describe("Unique identifier of the message to be updated"),
        message_status: z
          .enum(["SENT", "FAILED", "READ"])
          .describe("The new status of the message"),
        error_message_for_failed_status: z
          .string()
          .optional()
          .describe("Error message clarifying the failure. Only used when message_status is FAILED"),
      },
    },
    async (args) =>
      runTool(() => {
        const body: Record<string, unknown> = { statusType: args.message_status };
        if (args.error_message_for_failed_status !== undefined) {
          body.errorMessage = args.error_message_for_failed_status;
        }
        return client.request(
          "PATCH",
          `/${encodeURIComponent(args.channel_identifier)}/messages/${encodeURIComponent(args.message_id)}`,
          { body, root: "customChannels" },
        );
      }),
  );
}
