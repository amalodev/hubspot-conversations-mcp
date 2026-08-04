import { describe, expect, it } from "vitest";
import { buildQuery } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { errorText, stripNulls, toolText } from "../src/format.js";
import { HubSpotApiError } from "../src/client.js";
import { deriveReplyRecipients } from "../src/reply.js";
import type { PublicMessage } from "../src/hubspot-types.js";

describe("buildQuery", () => {
  it("skips undefined values and serializes primitives", () => {
    expect(buildQuery({ a: "x", b: 2, c: true, d: undefined })).toBe("?a=x&b=2&c=true");
  });

  it("repeats array parameters", () => {
    expect(buildQuery({ inboxId: ["1", "2"], limit: 10 })).toBe("?inboxId=1&inboxId=2&limit=10");
  });

  it("returns empty string for no params", () => {
    expect(buildQuery({})).toBe("");
  });
});

describe("loadConfig", () => {
  it("throws without a token", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/HUBSPOT_ACCESS_TOKEN/);
  });

  it("auto-detects private-app mode from pat- prefix", () => {
    const config = loadConfig({ HUBSPOT_ACCESS_TOKEN: "pat-eu1-abc" } as NodeJS.ProcessEnv);
    expect(config.authMode).toBe("private-app");
    expect(config.baseUrl).toBe("https://api.hubapi.com");
    expect(config.apiVersion).toBe("2026-09-beta");
  });

  it("defaults to bearer for non-pat tokens and honors overrides", () => {
    const config = loadConfig({
      HUBSPOT_ACCESS_TOKEN: "oauth-token",
      HUBSPOT_BASE_URL: "https://example.test/",
      HUBSPOT_CONVERSATIONS_API_VERSION: "v3",
      HUBSPOT_DEFAULT_SENDER_ACTOR_ID: "A-42",
    } as NodeJS.ProcessEnv);
    expect(config.authMode).toBe("bearer");
    expect(config.baseUrl).toBe("https://example.test");
    expect(config.apiVersion).toBe("v3");
    expect(config.defaultSenderActorId).toBe("A-42");
  });

  it("rejects invalid HUBSPOT_AUTH_MODE", () => {
    expect(() =>
      loadConfig({ HUBSPOT_ACCESS_TOKEN: "x", HUBSPOT_AUTH_MODE: "nope" } as NodeJS.ProcessEnv),
    ).toThrow(/HUBSPOT_AUTH_MODE/);
  });
});

describe("stripNulls / toolText", () => {
  it("removes null and undefined fields recursively", () => {
    expect(
      stripNulls({ a: 1, b: null, c: { d: undefined, e: "x" }, f: [null, { g: null, h: 2 }] }),
    ).toEqual({ a: 1, c: { e: "x" }, f: [null, { h: 2 }] });
  });

  it("keeps empty arrays so 'no results' stays visible", () => {
    expect(toolText({ results: [] })).toContain('"results": []');
  });
});

describe("errorText", () => {
  it("formats HubSpot API errors with category and correlationId", () => {
    const error = new HubSpotApiError("Thread not found", 404, "OBJECT_NOT_FOUND", "corr-123");
    const text = errorText(error);
    expect(text).toContain("404");
    expect(text).toContain("Thread not found");
    expect(text).toContain("OBJECT_NOT_FOUND");
    expect(text).toContain("corr-123");
  });
});

describe("deriveReplyRecipients", () => {
  const incoming = (overrides: Partial<PublicMessage>): PublicMessage => ({
    id: "m1",
    type: "MESSAGE",
    direction: "INCOMING",
    createdAt: "2026-08-01T10:00:00Z",
    ...overrides,
  });

  it("uses senders of the newest incoming MESSAGE", () => {
    const messages: PublicMessage[] = [
      incoming({
        id: "old",
        createdAt: "2026-08-01T09:00:00Z",
        senders: [{ actorId: "V-1", deliveryIdentifier: { type: "HS_EMAIL_ADDRESS", value: "old@x.dk" } }],
      }),
      incoming({
        id: "new",
        createdAt: "2026-08-02T09:00:00Z",
        senders: [
          {
            actorId: "V-2",
            name: "Kunde",
            deliveryIdentifier: { type: "HS_EMAIL_ADDRESS", value: "kunde@x.dk" },
          },
        ],
      }),
      {
        id: "out",
        type: "MESSAGE",
        direction: "OUTGOING",
        createdAt: "2026-08-03T09:00:00Z",
        senders: [{ actorId: "A-9", deliveryIdentifier: { type: "HS_EMAIL_ADDRESS", value: "os@amalo.dk" } }],
      },
      { id: "sys", type: "THREAD_STATUS_CHANGE", createdAt: "2026-08-04T09:00:00Z" },
    ];
    expect(deriveReplyRecipients(messages)).toEqual([
      {
        actorId: "V-2",
        name: "Kunde",
        deliveryIdentifiers: [{ type: "HS_EMAIL_ADDRESS", value: "kunde@x.dk" }],
      },
    ]);
  });

  it("supports plural deliveryIdentifiers on senders", () => {
    const messages = [
      incoming({
        senders: [{ deliveryIdentifiers: [{ type: "HS_PHONE_NUMBER", value: "+4512345678" }] }],
      }),
    ];
    expect(deriveReplyRecipients(messages)).toEqual([
      { deliveryIdentifiers: [{ type: "HS_PHONE_NUMBER", value: "+4512345678" }] },
    ]);
  });

  it("skips senders without actorId or delivery identifiers", () => {
    const messages = [incoming({ senders: [{ name: "Anonym" }] })];
    expect(deriveReplyRecipients(messages)).toBeUndefined();
  });

  it("returns undefined when there is no incoming message", () => {
    expect(deriveReplyRecipients([])).toBeUndefined();
    expect(
      deriveReplyRecipients([
        { id: "1", type: "COMMENT", createdAt: "2026-08-01T00:00:00Z" },
      ]),
    ).toBeUndefined();
  });
});
