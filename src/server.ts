import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubSpotClient } from "./client.js";
import type { HubSpotConfig } from "./config.js";
import { registerCustomChannelTools } from "./tools/custom-channels.js";
import { registerDirectoryTools } from "./tools/directory.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerThreadTools } from "./tools/threads.js";

export const SERVER_NAME = "hubspot-conversations";
export const SERVER_VERSION = "0.4.0";

export function createServer(client: HubSpotClient, config: HubSpotConfig): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerThreadTools(server, client);
  registerMessageTools(server, client, config);
  registerDirectoryTools(server, client);
  registerCustomChannelTools(server, client);
  return server;
}
