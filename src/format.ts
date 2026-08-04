import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HubSpotApiError } from "./client.js";

/** Recursively drop null/undefined object fields to keep tool output compact. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) continue;
      out[key] = stripNulls(item);
    }
    return out;
  }
  return value;
}

export function toolText(data: unknown): string {
  if (data === undefined) return "OK (no content)";
  if (typeof data === "string") return data;
  return JSON.stringify(stripNulls(data), null, 2);
}

export function errorText(error: unknown): string {
  if (error instanceof HubSpotApiError) {
    const parts = [`HubSpot API error ${error.status}: ${error.message}`];
    if (error.category) parts.push(`category: ${error.category}`);
    if (error.correlationId) parts.push(`correlationId: ${error.correlationId}`);
    return parts.join(" | ");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse a stringified-JSON `request_body` argument (Arcade-style tool input).
 * Returns {} when absent so typed arguments can be merged on top.
 */
export function parseRequestBody(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `request_body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request_body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Run a tool body and convert the outcome to an MCP tool result. */
export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: toolText(data) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: errorText(error) }] };
  }
}
