import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { HubSpotClient } from "../src/client.js";
import type { HubSpotConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

interface StubResponse {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

interface RecordedCall {
  method: string;
  url: URL;
  body?: unknown;
  headers: Record<string, string>;
}

function createStubFetch(handler: (call: RecordedCall) => StubResponse) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    };
    calls.push(call);
    const stub = handler(call);
    // 204/205/304 must have a null body per the fetch spec.
    return new Response(stub.json !== undefined ? JSON.stringify(stub.json) : null, {
      status: stub.status ?? (stub.json !== undefined ? 200 : 204),
      headers: { "content-type": "application/json", ...(stub.headers ?? {}) },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const TEST_CONFIG: HubSpotConfig = {
  accessToken: "pat-eu1-test-token",
  baseUrl: "https://api.hubapi.com",
  apiVersion: "2026-09-beta",
  customChannelsApiVersion: "2026-03",
  authMode: "private-app",
  defaultSenderActorId: "A-100",
};

const EXPECTED_TOOLS = [
  "ArchiveConversationThread",
  "CreateChannelAccount",
  "GetChannelAccountDetails",
  "GetCustomChannelAccounts",
  "GetCustomChannelMessageDetails",
  "GetInboxDetails",
  "GetMessageHistoryForThread",
  "ListConversationChannels",
  "ListConversationInboxes",
  "PublishCustomChannelMessage",
  "ResolveConversationActors",
  "RetrieveActorDetails",
  "RetrieveChannelAccountDetails",
  "RetrieveChannelAccounts",
  "RetrieveChannelDetails",
  "RetrieveConversationThreads",
  "RetrieveFullMessageContent",
  "RetrieveThreadById",
  "RetrieveThreadMessage",
  "SendConversationMessage",
  "UpdateChannelAccountInfo",
  "UpdateChannelAccountStaging",
  "UpdateConversationThread",
  "UpdateMessageStatus",
];

async function setup(
  handler: (call: RecordedCall) => StubResponse,
  configOverrides: Partial<HubSpotConfig> = {},
) {
  const { impl, calls } = createStubFetch(handler);
  const config = { ...TEST_CONFIG, ...configOverrides };
  const hubspot = new HubSpotClient(config, impl);
  const server = createServer(hubspot, config);
  const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return { mcpClient, calls };
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "").join("\n");
}

describe("hubspot-conversations MCP server", () => {
  it("registers exactly the 24 expected tools", async () => {
    const { mcpClient } = await setup(() => ({ json: {} }));
    const { tools } = await mcpClient.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("retrieves threads with filters, repeated params and private-app auth header", async () => {
    const { mcpClient, calls } = await setup(() => ({
      json: { results: [{ id: "42", status: "OPEN" }], paging: { next: { after: "cur" } } },
    }));

    const result = await mcpClient.callTool({
      name: "RetrieveConversationThreads",
      arguments: {
        inbox_id: ["1", "2"],
        thread_status: "OPEN",
        include_ticket_association: true,
        limit: 50,
      },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("GET");
    expect(call.url.pathname).toBe("/conversations/conversations/2026-09-beta/threads");
    expect(call.url.searchParams.getAll("inboxId")).toEqual(["1", "2"]);
    expect(call.url.searchParams.get("threadStatus")).toBe("OPEN");
    expect(call.url.searchParams.get("association")).toBe("TICKET");
    expect(call.url.searchParams.get("limit")).toBe("50");
    expect(call.headers["private-app"]).toBe("pat-eu1-test-token");
    expect(call.headers["authorization"]).toBeUndefined();
    expect(resultText(result)).toContain('"id": "42"');
    expect(resultText(result)).toContain('"after": "cur"');
  });

  it("uses bearer auth when configured", async () => {
    const { mcpClient, calls } = await setup(() => ({ json: { results: [] } }), {
      accessToken: "oauth-abc",
      authMode: "bearer",
    });
    await mcpClient.callTool({ name: "ListConversationInboxes", arguments: {} });
    expect(calls[0].headers["authorization"]).toBe("Bearer oauth-abc");
    expect(calls[0].headers["private-app"]).toBeUndefined();
  });

  it("sends a reply deriving channel, account and recipients from the thread", async () => {
    const { mcpClient, calls } = await setup((call) => {
      if (call.method === "GET" && call.url.pathname.endsWith("/threads/777")) {
        return {
          json: {
            id: "777",
            originalChannelId: "1002",
            originalChannelAccountId: "2002",
            status: "OPEN",
          },
        };
      }
      if (call.method === "GET" && call.url.pathname.endsWith("/threads/777/messages")) {
        return {
          json: {
            results: [
              {
                id: "m-out",
                type: "MESSAGE",
                direction: "OUTGOING",
                createdAt: "2026-08-02T10:00:00Z",
                senders: [{ actorId: "A-100" }],
              },
              {
                id: "m-in",
                type: "MESSAGE",
                direction: "INCOMING",
                createdAt: "2026-08-01T10:00:00Z",
                senders: [
                  {
                    actorId: "V-55",
                    name: "Kunde Hansen",
                    deliveryIdentifier: { type: "HS_EMAIL_ADDRESS", value: "kunde@example.dk" },
                  },
                ],
              },
            ],
          },
        };
      }
      if (call.method === "POST" && call.url.pathname.endsWith("/threads/777/messages")) {
        return { status: 201, json: { id: "m-new", type: "MESSAGE" } };
      }
      throw new Error(`Unexpected call: ${call.method} ${call.url.pathname}`);
    });

    const result = await mcpClient.callTool({
      name: "SendConversationMessage",
      arguments: { thread_id: "777", text: "Hej! Vi kigger på det." },
    });

    expect(result.isError).toBeFalsy();
    const post = calls.find((call) => call.method === "POST");
    expect(post).toBeDefined();
    expect(post!.body).toEqual({
      type: "MESSAGE",
      text: "Hej! Vi kigger på det.",
      senderActorId: "A-100",
      channelId: "1002",
      channelAccountId: "2002",
      recipients: [
        {
          actorId: "V-55",
          name: "Kunde Hansen",
          deliveryIdentifiers: [{ type: "HS_EMAIL_ADDRESS", value: "kunde@example.dk" }],
        },
      ],
      attachments: [],
    });
    expect(resultText(result)).toContain("m-new");
  });

  it("sends explicit typed fields without fetching the thread", async () => {
    const { mcpClient, calls } = await setup((call) => {
      if (call.method === "POST") return { status: 201, json: { id: "m-2" } };
      throw new Error(`Unexpected call: ${call.method} ${call.url.pathname}`);
    });

    await mcpClient.callTool({
      name: "SendConversationMessage",
      arguments: {
        thread_id: "9",
        text: "Direkte besked",
        sender_actor_id: "A-7",
        channel_id: "1000",
        channel_account_id: "2000",
        subject: "Re: Support",
        recipients: [
          { deliveryIdentifiers: [{ type: "HS_EMAIL_ADDRESS", value: "x@y.dk" }], recipientField: "TO" },
        ],
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      type: "MESSAGE",
      senderActorId: "A-7",
      subject: "Re: Support",
    });
  });

  it("accepts a stringified request_body (COMMENT needs no thread lookup)", async () => {
    const { mcpClient, calls } = await setup((call) => {
      if (call.method === "POST") return { status: 201, json: { id: "c-1", type: "COMMENT" } };
      throw new Error(`Unexpected call: ${call.method} ${call.url.pathname}`);
    });

    const result = await mcpClient.callTool({
      name: "SendConversationMessage",
      arguments: {
        thread_id: "5",
        request_body: JSON.stringify({ type: "COMMENT", text: "Internt notat" }),
      },
    });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ type: "COMMENT", text: "Internt notat", attachments: [] });
  });

  it("returns the body schema in get_request_schema mode without any API call", async () => {
    const { mcpClient, calls } = await setup(() => ({ json: {} }));
    const result = await mcpClient.callTool({
      name: "SendConversationMessage",
      arguments: { mode: "get_request_schema", thread_id: "1" },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("senderActorId");
    expect(calls).toHaveLength(0);
  });

  it("fails SendConversationMessage without a sender actor", async () => {
    const { mcpClient, calls } = await setup(() => ({ json: {} }), {
      defaultSenderActorId: undefined,
    });
    const result = await mcpClient.callTool({
      name: "SendConversationMessage",
      arguments: { thread_id: "1", text: "hej" },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("sender_actor_id");
    expect(calls).toHaveLength(0);
  });

  it("updates thread status, restores archived threads, and validates empty updates", async () => {
    const { mcpClient, calls } = await setup(() => ({ json: { id: "3" } }));

    const empty = await mcpClient.callTool({
      name: "UpdateConversationThread",
      arguments: { thread_identifier: "3" },
    });
    expect(empty.isError).toBe(true);
    expect(calls).toHaveLength(0);

    await mcpClient.callTool({
      name: "UpdateConversationThread",
      arguments: { thread_identifier: "3", thread_status: "CLOSED" },
    });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toEqual({ status: "CLOSED" });
    expect(calls[0].url.searchParams.get("archived")).toBeNull();

    await mcpClient.callTool({
      name: "UpdateConversationThread",
      arguments: { thread_identifier: "3", is_thread_archived: false },
    });
    expect(calls[1].body).toEqual({ archived: false });
    expect(calls[1].url.searchParams.get("archived")).toBe("true");
  });

  it("archives a thread via DELETE", async () => {
    const { mcpClient, calls } = await setup(() => ({ status: 204 }));
    const result = await mcpClient.callTool({
      name: "ArchiveConversationThread",
      arguments: { thread_identifier: "12" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url.pathname).toBe("/conversations/conversations/2026-09-beta/threads/12");
    expect(resultText(result)).toContain("12");
  });

  it("surfaces HubSpot errors with correlationId as tool errors", async () => {
    const { mcpClient } = await setup(() => ({
      status: 404,
      json: {
        status: "error",
        message: "Thread not found",
        category: "OBJECT_NOT_FOUND",
        correlationId: "corr-abc-123",
      },
    }));
    const result = await mcpClient.callTool({
      name: "RetrieveThreadById",
      arguments: { conversation_thread_id: "999" },
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("404");
    expect(text).toContain("Thread not found");
    expect(text).toContain("corr-abc-123");
  });

  it("batch-resolves actors via POST", async () => {
    const { mcpClient, calls } = await setup(() => ({
      json: { status: "COMPLETE", results: [{ id: "A-1", type: "AGENT" }] },
    }));
    await mcpClient.callTool({
      name: "ResolveConversationActors",
      arguments: { actor_ids: ["A-1", "V-2"] },
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe(
      "/conversations/conversations/2026-09-beta/actors/batch/read",
    );
    expect(calls[0].body).toEqual({ inputs: ["A-1", "V-2"] });
  });

  it("creates a custom channel account on the custom-channels API root", async () => {
    const { mcpClient, calls } = await setup(() => ({ status: 201, json: { id: "acc-1" } }));
    await mcpClient.callTool({
      name: "CreateChannelAccount",
      arguments: {
        account_name: "Amalo SMS",
        channel_id: "55",
        inbox_id: "7",
        is_authorized: true,
        delivery_identifier_type: "HS_PHONE_NUMBER",
        delivery_identifier_value: "+4512345678",
      },
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe(
      "/conversations/custom-channels/2026-03/55/channel-accounts",
    );
    expect(calls[0].body).toEqual({
      name: "Amalo SMS",
      inboxId: "7",
      authorized: true,
      deliveryIdentifier: { type: "HS_PHONE_NUMBER", value: "+4512345678" },
    });
  });

  it("publishes a custom channel message and validates required fields", async () => {
    const { mcpClient, calls } = await setup(() => ({ status: 201, json: { id: "msg-1" } }));

    const missing = await mcpClient.callTool({
      name: "PublishCustomChannelMessage",
      arguments: { custom_channel_id: "55", text: "Hej" },
    });
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toContain("channelAccountId");
    expect(calls).toHaveLength(0);

    await mcpClient.callTool({
      name: "PublishCustomChannelMessage",
      arguments: {
        custom_channel_id: "55",
        channel_account_id: "acc-1",
        text: "Hej fra SMS",
        integration_thread_id: "ext-42",
        senders: [{ deliveryIdentifier: { type: "HS_PHONE_NUMBER", value: "+4512345678" } }],
        recipients: [{ deliveryIdentifier: { type: "HS_PHONE_NUMBER", value: "+4587654321" } }],
      },
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/conversations/custom-channels/2026-03/55/messages");
    expect(calls[0].body).toMatchObject({
      channelAccountId: "acc-1",
      text: "Hej fra SMS",
      integrationThreadId: "ext-42",
    });
  });

  it("updates custom channel message status with statusType body", async () => {
    const { mcpClient, calls } = await setup(() => ({ json: { id: "msg-1" } }));
    await mcpClient.callTool({
      name: "UpdateMessageStatus",
      arguments: {
        channel_identifier: "55",
        message_id: "msg-1",
        message_status: "FAILED",
        error_message_for_failed_status: "Number unreachable",
      },
    });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url.pathname).toBe(
      "/conversations/custom-channels/2026-03/55/messages/msg-1",
    );
    expect(calls[0].body).toEqual({ statusType: "FAILED", errorMessage: "Number unreachable" });
  });

  it("routes remaining custom-channel reads to the custom-channels root", async () => {
    const { mcpClient, calls } = await setup(() => ({ json: { results: [] } }));
    await mcpClient.callTool({
      name: "GetCustomChannelAccounts",
      arguments: { custom_channel_id: "55" },
    });
    await mcpClient.callTool({
      name: "RetrieveChannelAccountDetails",
      arguments: { channel_identifier: "55", channel_account_id: "acc-9" },
    });
    await mcpClient.callTool({
      name: "GetCustomChannelMessageDetails",
      arguments: { channel_id: "55", message_id: "m-3" },
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/conversations/custom-channels/2026-03/55/channel-accounts",
      "/conversations/custom-channels/2026-03/55/channel-accounts/acc-9",
      "/conversations/custom-channels/2026-03/55/messages/m-3",
    ]);
  });

  it("updates channel account info and staging tokens", async () => {
    const { mcpClient, calls } = await setup(() => ({ json: { id: "acc-1" } }));

    const empty = await mcpClient.callTool({
      name: "UpdateChannelAccountInfo",
      arguments: { channel_id: "55", channel_account_id: "acc-1" },
    });
    expect(empty.isError).toBe(true);

    await mcpClient.callTool({
      name: "UpdateChannelAccountInfo",
      arguments: {
        channel_id: "55",
        channel_account_id: "acc-1",
        set_authorization_status: false,
      },
    });
    expect(calls[0].body).toEqual({ authorized: false });

    await mcpClient.callTool({
      name: "UpdateChannelAccountStaging",
      arguments: {
        channel_id: "55",
        account_token: "tok-1",
        account_name: "Ny konto",
        delivery_identifier_type: "HS_EMAIL_ADDRESS",
        delivery_identifier_value: "sms@amalo.dk",
      },
    });
    expect(calls[1].url.pathname).toBe(
      "/conversations/custom-channels/2026-03/55/channel-account-staging-tokens/tok-1",
    );
    expect(calls[1].body).toEqual({
      accountName: "Ny konto",
      deliveryIdentifier: { type: "HS_EMAIL_ADDRESS", value: "sms@amalo.dk" },
    });
  });

  it("gets inbox details by id", async () => {
    const { mcpClient, calls } = await setup(() => ({ json: { id: "7", name: "Support" } }));
    await mcpClient.callTool({ name: "GetInboxDetails", arguments: { inbox_id: "7" } });
    expect(calls[0].url.pathname).toBe("/conversations/conversations/2026-09-beta/inboxes/7");
  });
});
