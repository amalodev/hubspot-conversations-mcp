import * as readline from "node:readline";
import {
  ALL_CLIENTS,
  MCP_SERVER_KEY,
  parseClientSelection,
  runInstall,
  type ClientId,
  type InstallOptions,
} from "./install.js";

export interface SetupFlags {
  scope?: string;
  configPath?: string;
  hermesConfigPath?: string;
  dryRun: boolean;
}

const TOKEN_GUIDE = `
HubSpot Conversations MCP — setup
=================================

Step 1/3 · Create a HubSpot service key
  1. Open https://app.hubspot.com and go to: Development → Keys → Service Keys
  2. Click "Create service key" and give it a name (e.g. "hubspot-conversations-mcp")
  3. Add the scopes:
       • conversations.read
       • conversations.write
       • conversations.custom_channels.read / .write  (only if you'll use custom channels)
  4. Click "Create", open the key and click "Show" — copy the key (starts with "pat-")

  Legacy private app tokens and OAuth2 access tokens with the same scopes also work.
  Docs: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys
`;

interface Prompter {
  ask(prompt: string): Promise<string>;
  askHidden(prompt: string): Promise<string>;
  close(): void;
}

/** Interactive prompter for a real terminal; hides token input while typing. */
function createTtyPrompter(): Prompter {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));
  const askHidden = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      const target = rl as readline.Interface & {
        output: NodeJS.WritableStream;
        _writeToOutput?: (chunk: string) => void;
      };
      const original = target._writeToOutput?.bind(target);
      target._writeToOutput = (chunk: string) => {
        // Echo the prompt itself and newlines, mask everything typed.
        if (chunk.includes(prompt) || chunk === "\r\n" || chunk === "\n") {
          target.output.write(chunk);
        } else {
          target.output.write("*");
        }
      };
      rl.question(prompt, (answer) => {
        if (original) target._writeToOutput = original;
        else delete target._writeToOutput;
        target.output.write("\n");
        resolve(answer);
      });
    });
  return { ask, askHidden, close: () => rl.close() };
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
  const ask = async (prompt: string): Promise<string> => {
    const answer = index < lines.length ? lines[index++] : "";
    process.stdout.write(`${prompt}${answer ? "<from stdin>" : ""}\n`);
    return answer;
  };
  return { ask, askHidden: ask, close: () => {} };
}

async function askToken(prompter: Prompter): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = (await prompter.askHidden("Paste your HubSpot service key: ")).trim();
    if (token) {
      if (!token.startsWith("pat-")) {
        console.log(
          "  Note: service keys and legacy tokens start with \"pat-\" — assuming an OAuth access token.",
        );
      }
      return token;
    }
    console.log("  The token cannot be empty.");
  }
  throw new Error("No token provided after 3 attempts — aborting setup.");
}

async function askClients(prompter: Prompter): Promise<ClientId[]> {
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

export async function runSetup(flags: SetupFlags): Promise<void> {
  const prompter = process.stdin.isTTY ? createTtyPrompter() : await createPipePrompter();
  try {
    console.log(TOKEN_GUIDE);
    const token = await askToken(prompter);
    const senderActorId =
      (
        await prompter.ask(
          "Default sender actor ID for replies, e.g. A-12345 [Enter to skip]: ",
        )
      ).trim() || undefined;

    const clients = await askClients(prompter);

    console.log(`\nStep 3/3 · Installing for: ${clients.join(", ")}\n`);
    const options: InstallOptions = {
      clients,
      token,
      senderActorId,
      // Setup registers Claude Code across all projects unless overridden.
      scope: flags.scope ?? "user",
      configPath: flags.configPath,
      hermesConfigPath: flags.hermesConfigPath,
      dryRun: flags.dryRun,
    };
    runInstall(options);

    console.log(`
Done. The "${MCP_SERVER_KEY}" MCP server is configured.
  • Claude Desktop: restart the app to load the server
  • Claude Code:    available in new sessions (scope: ${options.scope})
  • Hermes:         run \`hermes mcp test ${MCP_SERVER_KEY}\` or /reload-mcp in a session

The server runs via: npx -y hubspot-conversations-mcp`);
  } finally {
    prompter.close();
  }
}
