#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HubSpotClient } from "./client.js";
import { loadConfig } from "./config.js";
import { PACKAGE_NAME, parseClientSelection, runInstall, type InstallOptions } from "./install.js";
import {
  clearTokenStore,
  DEFAULT_BROKER_URL,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_SCOPES,
  introspectAccessToken,
  readTokenStore,
  resolveTokenProvider,
  runLogin,
  tokenStorePath,
} from "./oauth.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { runSetup } from "./setup.js";

const HELP = `${PACKAGE_NAME} v${SERVER_VERSION}

Usage:
  ${PACKAGE_NAME}                  Run the MCP server on stdio (what MCP clients invoke)
  ${PACKAGE_NAME} setup            Interactive setup: auth + choose agents + install
  ${PACKAGE_NAME} install          Non-interactive install (flags below)
  ${PACKAGE_NAME} login            Per-user OAuth sign-in via your org's auth broker
  ${PACKAGE_NAME} logout           Remove the locally stored OAuth tokens
  ${PACKAGE_NAME} whoami           Show which credentials the server would use
  ${PACKAGE_NAME} --help           Show this help
  ${PACKAGE_NAME} --version        Print the version

Install options:
  --client <selection>         claude-desktop, claude-code, hermes, both, or all
                               (comma-separated combinations allowed)
  --token <pat-...>            HubSpot service key (or set HUBSPOT_ACCESS_TOKEN)
  --oauth                      Install without a token — the server uses the local
                               OAuth token store (run \`login\` first on each machine)
  --sender-actor-id <A-123>    Optional default sender for SendConversationMessage
  --scope <local|user|project> Claude Code registration scope (default: local; setup: user)
  --config-path <path>         Override the claude_desktop_config.json location
  --hermes-config-path <path>  Override the Hermes config.yaml location (~/.hermes/config.yaml)
  --dry-run                    Print what would happen without changing anything

Login options:
  --broker-url <url>           OAuth broker (default: ${DEFAULT_BROKER_URL};
                               or set HUBSPOT_OAUTH_BROKER_URL)
  --client-id <id>             Skip fetching the client ID from the broker
  --scopes <a,b>               Scopes to request (default: ${DEFAULT_SCOPES.join(",")})
  --port <n>                   Local callback port (default: ${DEFAULT_CALLBACK_PORT} — must match
                               the redirect URL registered on the HubSpot app)
  --no-open                    Print the authorize URL without opening a browser

Examples:
  npx ${PACKAGE_NAME} setup
  npx ${PACKAGE_NAME} login
  npx ${PACKAGE_NAME} install --client all --oauth
  npx ${PACKAGE_NAME} install --client all --token pat-eu1-... --sender-actor-id A-12345

Environment (server mode):
  HUBSPOT_ACCESS_TOKEN               service key — takes precedence over OAuth tokens
  HUBSPOT_DEFAULT_SENDER_ACTOR_ID    optional
  HUBSPOT_OAUTH_BROKER_URL           default broker for \`login\`
  HUBSPOT_TOKEN_STORE_PATH           OAuth token store (default ~/.hubspot-conversations-mcp/tokens.json)
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
      oauth: { type: "boolean", default: false },
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
  if (!token && !values.oauth) {
    throw new Error(
      "Provide credentials: --token / HUBSPOT_ACCESS_TOKEN (service key), or --oauth to use " +
        "the per-user OAuth token store (run `login` first). Or run `setup` for the wizard.",
    );
  }
  if (values.oauth && !readTokenStore()) {
    throw new Error(
      `--oauth requires a completed login on this machine (no token store at ${tokenStorePath()}). ` +
        "Run `npx hubspot-conversations-mcp login --broker-url <url>` first.",
    );
  }

  const options: InstallOptions = {
    clients,
    token: values.oauth ? undefined : token,
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

async function runLoginCli(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "broker-url": { type: "string" },
      "client-id": { type: "string" },
      scopes: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
    },
  });
  const brokerUrl =
    values["broker-url"] ?? process.env.HUBSPOT_OAUTH_BROKER_URL?.trim() ?? DEFAULT_BROKER_URL;
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("--port must be an integer between 1 and 65535.");
  }
  await runLogin({
    brokerUrl,
    clientId: values["client-id"],
    scopes: values.scopes?.split(/[\s,]+/).filter(Boolean),
    port,
    openBrowser: !values["no-open"],
  });
}

async function runWhoamiCli(): Promise<void> {
  const envToken = process.env.HUBSPOT_ACCESS_TOKEN?.trim();
  if (envToken) {
    console.log(`Mode: static token (HUBSPOT_ACCESS_TOKEN, ${envToken.slice(0, 8)}…)`);
    console.log("This takes precedence over any OAuth token store.");
    return;
  }
  const store = readTokenStore();
  if (!store) {
    console.log("Not signed in: no HUBSPOT_ACCESS_TOKEN and no OAuth token store.");
    console.log(`Run \`npx ${PACKAGE_NAME} login --broker-url <url>\` or set HUBSPOT_ACCESS_TOKEN.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Mode: per-user OAuth (store: ${tokenStorePath()})`);
  console.log(`Broker: ${store.brokerUrl}`);
  if (store.user) console.log(`User: ${store.user}`);
  if (store.hubId) console.log(`Portal: ${store.hubId}`);
  if (store.scopes?.length) console.log(`Scopes: ${store.scopes.join(", ")}`);
  const expiresIn = Math.round((store.expiresAt - Date.now()) / 1000);
  console.log(
    expiresIn > 0
      ? `Access token expires in ${expiresIn}s (auto-refreshed via the broker).`
      : "Access token expired — it will be refreshed on the next request.",
  );
  const live = await introspectAccessToken(store.accessToken);
  if (live?.hubId) console.log(`Verified live against portal ${live.hubId}.`);
}

async function runServer(): Promise<void> {
  const config = loadConfig();
  const provider = resolveTokenProvider(config);
  const client = new HubSpotClient(config, globalThis.fetch, provider);
  const server = createServer(client, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the MCP protocol — log to stderr only.
  const mode = config.accessToken ? `static (${config.authMode})` : "oauth";
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (auth: ${mode})`);
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
  if (argv[0] === "login") {
    await runLoginCli(argv.slice(1));
    return;
  }
  if (argv[0] === "logout") {
    console.log(clearTokenStore() ? `Signed out — removed ${tokenStorePath()}.` : "No OAuth tokens stored.");
    return;
  }
  if (argv[0] === "whoami") {
    await runWhoamiCli();
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
