import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubSpotClient } from "./client.js";
import type { HubSpotConfig } from "./config.js";
import { scopeChecker } from "./scopes.js";
import { registerCustomChannelTools } from "./tools/custom-channels.js";
import { registerDirectoryTools } from "./tools/directory.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerThreadTools } from "./tools/threads.js";

export const SERVER_NAME = "hubspot-conversations";
export const SERVER_VERSION = "0.11.0";

export interface ServerOptions {
  /**
   * Scopes granted to the active sign-in; tools whose scope is missing are
   * not registered. Omitted/empty means unknown → all tools are offered.
   */
  grantedScopes?: string[];
}

export function createServer(
  client: HubSpotClient,
  config: HubSpotConfig,
  options: ServerOptions = {},
): McpServer {
  const can = scopeChecker(options.grantedScopes);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerThreadTools(server, client, can);
  registerMessageTools(server, client, config, can);
  registerDirectoryTools(server, client, can);
  registerCustomChannelTools(server, client, can);
  return server;
}
