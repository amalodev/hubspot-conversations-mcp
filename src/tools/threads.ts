import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HubSpotClient } from "../client.js";
import { runTool } from "../format.js";

export function registerThreadTools(server: McpServer, client: HubSpotClient): void {
  server.registerTool(
    "RetrieveConversationThreads",
    {
      title: "Retrieve conversation threads",
      description:
        "Retrieve conversation threads from HubSpot Conversations. You can apply optional filters " +
        "(inbox, OPEN/CLOSED status, associated contact or ticket, time window) and sorting to " +
        "tailor the results. Paginated: pass `after` from the previous response's paging.next.after.",
      inputSchema: {
        thread_status: z.enum(["OPEN", "CLOSED"]).optional().describe("Filter by thread status"),
        inbox_id: z.array(z.string()).optional().describe("Only threads in these inbox IDs"),
        associated_contact_id: z
          .string()
          .optional()
          .describe("Only threads associated with this CRM contact ID"),
        associated_ticket_id: z
          .string()
          .optional()
          .describe("Only threads associated with this ticket ID"),
        latest_message_timestamp_after: z
          .string()
          .optional()
          .describe("Only threads with messages after this ISO 8601 timestamp, e.g. 2026-08-01T00:00:00Z"),
        latest_message_timestamp_before: z
          .string()
          .optional()
          .describe("Only threads with messages before this ISO 8601 timestamp"),
        is_archived: z.boolean().optional().describe("Set true to list archived threads instead"),
        include_ticket_association: z
          .boolean()
          .optional()
          .describe("Include associated ticket IDs on each thread"),
        sort: z.array(z.string()).optional().describe("Fields to sort by, e.g. latestMessageTimestamp"),
        limit: z.number().int().min(1).optional().describe("Max results per page"),
        after: z.string().optional().describe("Pagination cursor from paging.next.after"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request("GET", "/threads", {
          query: {
            threadStatus: args.thread_status,
            inboxId: args.inbox_id,
            associatedContactId: args.associated_contact_id,
            associatedTicketId: args.associated_ticket_id,
            latestMessageTimestampAfter: args.latest_message_timestamp_after,
            latestMessageTimestampBefore: args.latest_message_timestamp_before,
            archived: args.is_archived,
            association: args.include_ticket_association ? ["TICKET"] : undefined,
            sort: args.sort,
            limit: args.limit,
            after: args.after,
          },
        }),
      ),
  );

  server.registerTool(
    "RetrieveThreadById",
    {
      title: "Retrieve a thread by ID",
      description:
        "Retrieve detailed information about a conversation thread by ID: status, inbox, original " +
        "channel, assignee and associated contact.",
      inputSchema: {
        conversation_thread_id: z
          .string()
          .describe("The unique identifier for the conversation thread you wish to retrieve"),
        include_ticket_association: z
          .boolean()
          .optional()
          .describe("Include associated ticket IDs"),
        is_archived: z.boolean().optional().describe("Set true if the thread is archived"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(() =>
        client.request("GET", `/threads/${encodeURIComponent(args.conversation_thread_id)}`, {
          query: {
            association: args.include_ticket_association ? ["TICKET"] : undefined,
            archived: args.is_archived,
          },
        }),
      ),
  );

  server.registerTool(
    "UpdateConversationThread",
    {
      title: "Update or restore a conversation thread",
      description:
        "Update a single thread's status (OPEN/CLOSED) or archive/restore it. Set " +
        "is_thread_archived=true to archive, false to restore an archived thread.",
      inputSchema: {
        thread_identifier: z
          .string()
          .describe("The unique identifier for the conversation thread to update or restore"),
        thread_status: z
          .enum(["OPEN", "CLOSED"])
          .optional()
          .describe("Set the thread's status to OPEN or CLOSED"),
        is_thread_archived: z
          .boolean()
          .optional()
          .describe("Set to true to archive or false to restore the thread"),
      },
    },
    async (args) =>
      runTool(async () => {
        if (args.thread_status === undefined && args.is_thread_archived === undefined) {
          throw new Error("Provide at least one of `thread_status` or `is_thread_archived`.");
        }
        const body: Record<string, unknown> = {};
        if (args.thread_status !== undefined) body.status = args.thread_status;
        if (args.is_thread_archived !== undefined) body.archived = args.is_thread_archived;
        return client.request(
          "PATCH",
          `/threads/${encodeURIComponent(args.thread_identifier)}`,
          {
            // Restoring requires addressing the currently-archived thread.
            query: { archived: args.is_thread_archived === false ? true : undefined },
            body,
          },
        );
      }),
  );

  server.registerTool(
    "ArchiveConversationThread",
    {
      title: "Archive a conversation thread",
      description:
        "Archives a conversation thread, marking it for deletion. The thread is permanently " +
        "deleted after 30 days.",
      inputSchema: {
        thread_identifier: z
          .string()
          .describe("The unique identifier of the conversation thread to archive"),
      },
      annotations: { destructiveHint: true },
    },
    async (args) =>
      runTool(async () => {
        await client.request("DELETE", `/threads/${encodeURIComponent(args.thread_identifier)}`);
        return `Thread ${args.thread_identifier} archived (permanently deleted after 30 days).`;
      }),
  );
}
