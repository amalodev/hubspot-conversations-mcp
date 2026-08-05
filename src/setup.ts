import * as p from "@clack/prompts";
import {
  ALL_CLIENTS,
  MCP_SERVER_KEY,
  PACKAGE_NAME,
  parseClientSelection,
  runInstall,
  type ClientId,
  type InstallOptions,
} from "./install.js";
import { runLogin } from "./oauth.js";
import { SERVER_VERSION } from "./server.js";

export interface SetupFlags {
  scope?: string;
  configPath?: string;
  hermesConfigPath?: string;
  dryRun: boolean;
}

const TOKEN_STEPS = `1. Open https://app.hubspot.com → Development → Keys → Service Keys
2. Click "Create service key" and name it (e.g. "${PACKAGE_NAME}")
3. Add the scopes:
     • conversations.read
     • conversations.write
     • conversations.custom_channels.read / .write  (custom channels only)
4. Click "Create", open the key and click "Show" — copy it (starts with "pat-")

Legacy private app tokens and OAuth2 access tokens also work.
Docs: https://developers.hubspot.com/docs/apps/developer-platform/
      build-apps/authentication/account-service-keys`;

const CLIENT_OPTIONS: Array<{ value: ClientId; label: string; hint: string }> = [
  { value: "claude-desktop", label: "Claude Desktop", hint: "merges claude_desktop_config.json" },
  { value: "claude-code", label: "Claude Code", hint: "runs claude mcp add" },
  { value: "hermes", label: "Hermes (Nous Research)", hint: "merges ~/.hermes/config.yaml" },
];

function nextSteps(clients: ClientId[], scope: string | undefined): string {
  const lines: string[] = [];
  if (clients.includes("claude-desktop")) {
    lines.push("Claude Desktop   restart the app to load the server");
  }
  if (clients.includes("claude-code")) {
    lines.push(`Claude Code      available in new sessions (scope: ${scope ?? "local"})`);
  }
  if (clients.includes("hermes")) {
    lines.push(`Hermes           hermes mcp test ${MCP_SERVER_KEY}  (or /reload-mcp)`);
  }
  return lines.join("\n");
}

function buildInstallOptions(
  flags: SetupFlags,
  token: string | undefined,
  senderActorId: string | undefined,
  clients: ClientId[],
  log?: (message: string) => void,
  logError?: (message: string) => void,
): InstallOptions {
  return {
    clients,
    token,
    senderActorId,
    // Setup registers Claude Code across all projects unless overridden.
    scope: flags.scope ?? "user",
    configPath: flags.configPath,
    hermesConfigPath: flags.hermesConfigPath,
    dryRun: flags.dryRun,
    log,
    logError,
  };
}

// --- Interactive wizard (TTY) — powered by @clack/prompts --------------------

/** Unwrap a clack prompt result, exiting cleanly if the user pressed Ctrl+C/Esc. */
function ensureAnswered<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled — nothing was changed.");
    process.exit(1);
  }
  return value as T;
}

async function askServiceKey(): Promise<string> {
  p.note(TOKEN_STEPS, "Step 1/3 · Create a HubSpot service key");
  const token = ensureAnswered(
    await p.password({
      message: "Paste your HubSpot service key",
      validate: (value) => (!value || value.trim() === "" ? "The service key cannot be empty" : undefined),
    }),
  ).trim();
  if (!token.startsWith("pat-")) {
    p.log.warn('Service keys and legacy tokens start with "pat-" — assuming an OAuth access token.');
  }
  return token;
}

async function runOAuthLogin(): Promise<void> {
  p.note(
    `Each user signs in with their own HubSpot login — no shared credentials.
Your org hosts a small OAuth broker (see the repo's api/ directory); you
only need its URL. The browser will open for the HubSpot consent screen.`,
    "Step 1/3 · Sign in with HubSpot",
  );
  const brokerUrl = ensureAnswered(
    await p.text({
      message: "Your org's OAuth broker URL",
      placeholder: "https://your-broker.vercel.app",
      initialValue: process.env.HUBSPOT_OAUTH_BROKER_URL?.trim() ?? "",
      validate: (value) => {
        if (!value?.trim()) return "The broker URL is required for OAuth login";
        try {
          new URL(value.trim());
          return undefined;
        } catch {
          return "Enter a full URL, e.g. https://your-broker.vercel.app";
        }
      },
    }),
  ).trim();
  await runLogin({ brokerUrl, log: (message) => p.log.info(message) });
}

async function runInteractiveSetup(flags: SetupFlags): Promise<void> {
  p.intro(`${PACKAGE_NAME} v${SERVER_VERSION} — setup`);

  const authMethod = ensureAnswered(
    await p.select({
      message: "How should this machine authenticate with HubSpot?",
      options: [
        {
          value: "oauth" as const,
          label: "Log in with HubSpot (per-user OAuth)",
          hint: "each user signs in individually — requires your org's auth broker",
        },
        {
          value: "service-key" as const,
          label: "Service key",
          hint: "one shared credential — simplest, also right for CI/automation",
        },
      ],
    }),
  );

  let token: string | undefined;
  if (authMethod === "service-key") {
    token = await askServiceKey();
  } else {
    await runOAuthLogin();
  }

  const senderRaw = ensureAnswered(
    await p.text({
      message: "Default sender actor ID for replies (optional)",
      placeholder: "A-12345 — press Enter to skip",
      defaultValue: "",
    }),
  );
  const senderActorId = senderRaw.trim() || undefined;

  const clients = ensureAnswered(
    await p.multiselect({
      message: "Step 2/3 · Which agents should be configured? (↑/↓ to move, space to toggle, enter to confirm)",
      options: CLIENT_OPTIONS,
      initialValues: [...ALL_CLIENTS],
      required: true,
    }),
  );

  p.log.step(
    `Step 3/3 · Installing for: ${clients.join(", ")}${flags.dryRun ? " (dry-run)" : ""}`,
  );
  const options = buildInstallOptions(
    flags,
    token,
    senderActorId,
    clients,
    (message) => p.log.info(message),
    (message) => p.log.error(message),
  );
  try {
    runInstall(options);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.cancel("Setup failed — see the error above.");
    process.exit(1);
  }

  const summary = nextSteps(clients, options.scope);
  if (summary) p.note(summary, "Next steps");
  p.outro(`Done — "${MCP_SERVER_KEY}" runs via npx -y ${PACKAGE_NAME}`);
}

// --- Scripted mode (piped stdin) ---------------------------------------------

const PIPE_GUIDE = `
HubSpot Conversations MCP — setup
=================================

Step 1/3 · Create a HubSpot service key
${TOKEN_STEPS}
`;

interface Prompter {
  ask(prompt: string): Promise<string>;
}

/**
 * Prompter for piped stdin (scripted setup). All input is read upfront —
 * readline drops lines that arrive while no question is pending, so consuming
 * a pre-read buffer is the only reliable way to script the wizard.
 */
async function createPipePrompter(): Promise<Prompter> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const lines = raw.split(/\r?\n/);
  let index = 0;
  return {
    ask: async (prompt: string): Promise<string> => {
      const answer = index < lines.length ? lines[index++] : "";
      process.stdout.write(`${prompt}${answer ? "<from stdin>" : ""}\n`);
      return answer;
    },
  };
}

async function askTokenPiped(prompter: Prompter): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = (await prompter.ask("Paste your HubSpot service key: ")).trim();
    if (token) {
      if (!token.startsWith("pat-")) {
        console.log(
          '  Note: service keys and legacy tokens start with "pat-" — assuming an OAuth access token.',
        );
      }
      return token;
    }
    console.log("  The service key cannot be empty.");
  }
  throw new Error("No service key provided after 3 attempts — aborting setup.");
}

async function askClientsPiped(prompter: Prompter): Promise<ClientId[]> {
  console.log(`
Step 2/3 · Choose which AI agents to configure
  1) Claude Desktop
  2) Claude Code
  3) Hermes (Nous Research hermes-agent)
`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await prompter.ask("Which agents? [numbers or names, Enter = all]: ");
    try {
      return parseClientSelection(answer);
    } catch (error) {
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log("  Falling back to: all agents.");
  return [...ALL_CLIENTS];
}

async function runPipedSetup(flags: SetupFlags): Promise<void> {
  const prompter = await createPipePrompter();
  console.log(PIPE_GUIDE);
  const token = await askTokenPiped(prompter);
  const senderActorId =
    (await prompter.ask("Default sender actor ID for replies, e.g. A-12345 [Enter to skip]: ")).trim() ||
    undefined;
  const clients = await askClientsPiped(prompter);

  console.log(`\nStep 3/3 · Installing for: ${clients.join(", ")}\n`);
  const options = buildInstallOptions(flags, token, senderActorId, clients);
  runInstall(options);

  console.log(`
Done. The "${MCP_SERVER_KEY}" MCP server is configured.
${nextSteps(clients, options.scope)}

The server runs via: npx -y ${PACKAGE_NAME}`);
}

// -----------------------------------------------------------------------------

export async function runSetup(flags: SetupFlags): Promise<void> {
  if (process.stdin.isTTY) {
    await runInteractiveSetup(flags);
  } else {
    await runPipedSetup(flags);
  }
}
