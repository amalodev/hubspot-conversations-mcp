#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HubSpotClient } from "./client.js";
import { loadConfig } from "./config.js";
import { PACKAGE_NAME, parseClientSelection, runInstall, type InstallOptions } from "./install.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { runSetup } from "./setup.js";

const HELP = `${PACKAGE_NAME} v${SERVER_VERSION}

Usage:
  ${PACKAGE_NAME}                  Run the MCP server on stdio (what MCP clients invoke)
  ${PACKAGE_NAME} setup            Interactive setup: token guide + choose agents + install
  ${PACKAGE_NAME} install          Non-interactive install (flags below)
  ${PACKAGE_NAME} --help           Show this help
  ${PACKAGE_NAME} --version        Print the version

Install options:
  --client <selection>         claude-desktop, claude-code, hermes, both, or all
                               (comma-separated combinations allowed)
  --token <pat-...>            HubSpot access token (or set HUBSPOT_ACCESS_TOKEN)
  --sender-actor-id <A-123>    Optional default sender for SendConversationMessage
  --scope <local|user|project> Claude Code registration scope (default: local; setup: user)
  --config-path <path>         Override the claude_desktop_config.json location
  --hermes-config-path <path>  Override the Hermes config.yaml location (~/.hermes/config.yaml)
  --dry-run                    Print what would happen without changing anything
  (setup also accepts --scope, --config-path, --hermes-config-path and --dry-run)

Examples:
  npx ${PACKAGE_NAME} setup
  npx ${PACKAGE_NAME} install --client all --token pat-eu1-... --sender-actor-id A-12345
  npx ${PACKAGE_NAME} install --client claude-desktop,hermes --dry-run --token pat-eu1-...

Environment (server mode):
  HUBSPOT_ACCESS_TOKEN               required
  HUBSPOT_DEFAULT_SENDER_ACTOR_ID    optional
  HUBSPOT_BASE_URL                   optional (default https://api.hubapi.com)
  HUBSPOT_CONVERSATIONS_API_VERSION  optional (default 2026-09-beta)
  HUBSPOT_CUSTOM_CHANNELS_API_VERSION optional (default 2026-03)
`;

function runInstallCli(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      client: { type: "string" },
      token: { type: "string" },
      "sender-actor-id": { type: "string" },
      scope: { type: "string" },
      "config-path": { type: "string" },
      "hermes-config-path": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.client) {
    throw new Error(
      "--client is required: claude-desktop, claude-code, hermes, both, or all " +
        "(comma-separated combinations allowed). Or run `setup` for the interactive wizard.",
    );
  }
  const clients = parseClientSelection(values.client);
  if (values.scope && !["local", "user", "project"].includes(values.scope)) {
    throw new Error("--scope must be local, user, or project.");
  }
  const token = values.token ?? process.env.HUBSPOT_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "A HubSpot access token is required: pass --token or set HUBSPOT_ACCESS_TOKEN. " +
        "Create one under Settings → Integrations → Private Apps with the conversations.read " +
        "and conversations.write scopes — or run `setup` for the interactive wizard.",
    );
  }

  const options: InstallOptions = {
    clients,
    token,
    senderActorId: values["sender-actor-id"],
    scope: values.scope,
    configPath: values["config-path"],
    hermesConfigPath: values["hermes-config-path"],
    dryRun: values["dry-run"] ?? false,
  };
  runInstall(options);
}

async function runSetupCli(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      scope: { type: "string" },
      "config-path": { type: "string" },
      "hermes-config-path": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (values.scope && !["local", "user", "project"].includes(values.scope)) {
    throw new Error("--scope must be local, user, or project.");
  }
  await runSetup({
    scope: values.scope,
    configPath: values["config-path"],
    hermesConfigPath: values["hermes-config-path"],
    dryRun: values["dry-run"] ?? false,
  });
}

async function runServer(): Promise<void> {
  const config = loadConfig();
  const client = new HubSpotClient(config);
  const server = createServer(client, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the MCP protocol — log to stderr only.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (auth: ${config.authMode})`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "setup") {
    await runSetupCli(argv.slice(1));
    return;
  }
  if (argv[0] === "install") {
    runInstallCli(argv.slice(1));
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(SERVER_VERSION);
    return;
  }
  await runServer();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
