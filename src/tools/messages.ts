import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HubSpotClient } from "../client.js";
import type { HubSpotConfig } from "../config.js";
import { parseRequestBody, runTool } from "../format.js";
import type { MessageParticipant, Paged, PublicMessage, PublicThread } from "../hubspot-types.js";
import { deriveReplyRecipients } from "../reply.js";

const deliveryIdentifierSchema = z.object({
  type: z
    .enum(["HS_EMAIL_ADDRESS", "HS_PHONE_NUMBER", "CHANNEL_SPECIFIC_OPAQUE_ID", "HS_SHORT_CODE"])
    .describe("Identifier type"),
  value: z.string().describe("The address / phone number / opaque ID"),
});

const recipientSchema = z.object({
  deliveryIdentifiers: z
    .array(deliveryIdentifierSchema)
    .optional()
    .describe("Where to deliver the message, e.g. [{type: 'HS_EMAIL_ADDRESS', value: 'a@b.com'}]"),
  actorId: z.string().optional().describe("Recipient actor ID, e.g. 'V-123' for a visitor/contact"),
  name: z.string().optional().describe("Recipient display name"),
  recipientField: z.enum(["TO", "CC", "BCC"]).optional().describe("Email recipient field"),
});

/** Returned by SendConversationMessage when mode="get_request_schema". */
const SEND_MESSAGE_BODY_SCHEMA = {
  endpoint: "POST /threads/{threadId}/messages",
  oneOf: [
    {
      description: "Send a message to the customer on the thread's channel",
      required: ["type", "text", "senderActorId", "channelId", "channelAccountId", "recipients", "attachments"],
      properties: {
        type: "MESSAGE",
        text: "Plain text content",
        richText: "Optional HTML content",
        subject: "Optional email subject",
        senderActorId: "e.g. 'A-12345' (a HubSpot user)",
        channelId: "Channel ID (thread's originalChannelId for a reply)",
        channelAccountId: "Channel account ID (thread's originalChannelAccountId for a reply)",
        recipients: [
          {
            deliveryIdentifiers: [{ type: "HS_EMAIL_ADDRESS", value: "customer@example.com" }],
            actorId: "Optional, e.g. 'V-123'",
            name: "Optional display name",
            recipientField: "TO | CC | BCC (optional)",
          },
        ],
        attachments: [],
      },
    },
    {
      description: "Post an internal comment (not delivered to the customer)",
      required: ["type", "text", "attachments"],
      properties: { type: "COMMENT", text: "Note text", richText: "Optional HTML", attachments: [] },
    },
  ],
};

const MAX_RECIPIENT_LOOKUP_PAGES = 5;

async function deriveRecipientsFromThread(
  client: HubSpotClient,
  threadId: string,
): Promise<MessageParticipant[] | undefined> {
  const messages: PublicMessage[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_RECIPIENT_LOOKUP_PAGES; page++) {
    const result = await client.request<Paged<PublicMessage>>(
      "GET",
      `/threads/${encodeURIComponent(threadId)}/messages`,
      { query: { limit: 100, after } },
    );
    messages.push(...(result.results ?? []));
    after = result.paging?.next?.after;
    if (!after) break;
  }
  return deriveReplyRecipients(messages);
}

export function registerMessageTools(
  server: McpServer,
  client: HubSpotClient,
  config: HubSpotConfig,
): void {
  server.registerTool(
    "GetMessageHistoryForThread",
    {
      title: "Get message history for a thread",
      description:
        "Retrieve the message history for a given conversation thread by its ID (messages, " +
        "comments and system events like assignments and status changes). Paginated: pass `after` " +
        "from paging.next.after to fetch the next page.",
      inputSchema: {
        thread_id: z
          .string()
          .describe("The unique identifier for the conversation thread whose message history is to be retrieved"),
        limit: z.number().int().min(1).optional().describe("Max results per page"),
        after: z.string().optional().describe("Pagination cursor from paging.next.after"),
        is_archived: z.boolean().optional().describe("Set true if the thread is archived"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request("GET", `/threads/${encodeURIComponent(args.thread_id)}/messages`, {
          query: { limit: args.limit, after: args.after, archived: args.is_archived },
        }),
      ),
  );

  server.registerTool(
    "RetrieveThreadMessage",
    {
      title: "Retrieve a single thread message",
      description:
        "Retrieve the details of a specific message within a conversation thread using the " +
        "message ID.",
      inputSchema: {
        thread_id: z
          .string()
          .describe("The unique identifier of the conversation thread from which to retrieve the message"),
        message_id: z
          .string()
          .describe("The unique identifier for the specific message within the thread"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request(
          "GET",
          `/threads/${encodeURIComponent(args.thread_id)}/messages/${encodeURIComponent(args.message_id)}`,
        ),
      ),
  );

  server.registerTool(
    "RetrieveFullMessageContent",
    {
      title: "Retrieve full original message content",
      description:
        "Retrieve the original text and rich text of a message — useful for untruncated content " +
        "when the message's truncationStatus indicates it might be truncated.",
      inputSchema: {
        conversation_thread_id: z
          .string()
          .describe("The unique identifier for the conversation thread containing the message"),
        message_id: z.string().describe("The unique identifier for the message"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request(
          "GET",
          `/threads/${encodeURIComponent(args.conversation_thread_id)}/messages/${encodeURIComponent(args.message_id)}/original-content`,
        ),
      ),
  );

  server.registerTool(
    "SendConversationMessage",
    {
      title: "Send a message in a conversation thread",
      description:
        "Send a new message on an existing conversation thread — delivered to the customer on the " +
        "thread's channel (set message_type=COMMENT for an internal note instead). Provide the " +
        "content either as typed fields (text, recipients, …) or as a stringified JSON " +
        "request_body; typed fields win on conflict. Missing channel_id/channel_account_id are " +
        "taken from the thread, missing recipients are derived from the latest incoming message, " +
        "and sender_actor_id falls back to HUBSPOT_DEFAULT_SENDER_ACTOR_ID. Call with " +
        "mode='get_request_schema' to inspect the raw request body schema.",
      inputSchema: {
        mode: z
          .enum(["get_request_schema", "execute"])
          .optional()
          .describe("'get_request_schema' returns the request body schema; default is 'execute'"),
        thread_id: z
          .string()
          .describe("The unique identifier for the conversation thread where the message will be sent"),
        request_body: z
          .string()
          .optional()
          .describe("Optional stringified JSON request body (see mode='get_request_schema')"),
        message_type: z
          .enum(["MESSAGE", "COMMENT"])
          .optional()
          .describe("MESSAGE (default) is sent to the customer; COMMENT is an internal note"),
        text: z.string().optional().describe("Plain text content of the message"),
        rich_text: z.string().optional().describe("Optional HTML content"),
        subject: z.string().optional().describe("Optional email subject"),
        sender_actor_id: z
          .string()
          .optional()
          .describe("Sending actor, e.g. 'A-12345'. Defaults to HUBSPOT_DEFAULT_SENDER_ACTOR_ID"),
        channel_id: z
          .string()
          .optional()
          .describe("Channel ID; defaults to the thread's originalChannelId"),
        channel_account_id: z
          .string()
          .optional()
          .describe("Channel account ID; defaults to the thread's originalChannelAccountId"),
        recipients: z
          .array(recipientSchema)
          .optional()
          .describe("Recipients; defaults to the senders of the latest incoming message"),
        attachments: z
          .array(z.record(z.unknown()))
          .optional()
          .describe("Optional attachments (see HubSpot attachment schemas); defaults to []"),
      },
      annotations: { openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        if (args.mode === "get_request_schema") return SEND_MESSAGE_BODY_SCHEMA;

        const fromJson = parseRequestBody(args.request_body);
        const type =
          args.message_type ?? (typeof fromJson.type === "string" ? fromJson.type : "MESSAGE");
        const text = args.text ?? fromJson.text;
        if (typeof text !== "string" || text.length === 0) {
          throw new Error("text is required — pass `text` or include it in request_body.");
        }

        const body: Record<string, unknown> = { ...fromJson, type, text };
        body.attachments = args.attachments ?? fromJson.attachments ?? [];
        const richText = args.rich_text ?? fromJson.richText;
        if (richText !== undefined) body.richText = richText;

        if (type === "MESSAGE") {
          const senderActorId =
            args.sender_actor_id ?? fromJson.senderActorId ?? config.defaultSenderActorId;
          if (!senderActorId) {
            throw new Error(
              "sender_actor_id is required: pass it explicitly or set HUBSPOT_DEFAULT_SENDER_ACTOR_ID. " +
                "Agent actor IDs look like 'A-<hubspot user id>'.",
            );
          }
          body.senderActorId = senderActorId;

          let channelId = args.channel_id ?? fromJson.channelId;
          let channelAccountId = args.channel_account_id ?? fromJson.channelAccountId;
          if (!channelId || !channelAccountId) {
            const thread = await client.request<PublicThread>(
              "GET",
              `/threads/${encodeURIComponent(args.thread_id)}`,
            );
            channelId ??= thread.originalChannelId;
            channelAccountId ??= thread.originalChannelAccountId;
            if (!channelId || !channelAccountId) {
              throw new Error(
                "Could not resolve channel_id/channel_account_id from the thread; pass them explicitly.",
              );
            }
          }
          body.channelId = channelId;
          body.channelAccountId = channelAccountId;

          let recipients = (args.recipients ?? fromJson.recipients) as
            | MessageParticipant[]
            | undefined;
          if (!recipients || recipients.length === 0) {
            recipients = await deriveRecipientsFromThread(client, args.thread_id);
            if (!recipients) {
              throw new Error(
                "Could not derive recipients from the thread's incoming messages. Pass `recipients` " +
                  "explicitly, e.g. [{deliveryIdentifiers: [{type: 'HS_EMAIL_ADDRESS', value: 'customer@example.com'}]}].",
              );
            }
          }
          body.recipients = recipients;

          const subject = args.subject ?? fromJson.subject;
          if (subject !== undefined) body.subject = subject;
        }

        return client.request("POST", `/threads/${encodeURIComponent(args.thread_id)}/messages`, {
          body,
        });
      }),
  );
}
