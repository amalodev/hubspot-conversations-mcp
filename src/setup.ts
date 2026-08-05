import * as p from "@clack/prompts";
import {
  ALL_CLIENTS,
  MCP_SERVER_KEY,
  PACKAGE_NAME,
  runInstall,
  type ClientId,
  type InstallOptions,
} from "./install.js";
import { brokerEndpoint, runLogin } from "./oauth.js";
import { SERVER_VERSION } from "./server.js";

export interface SetupFlags {
  scope?: string;
  configPath?: string;
  hermesConfigPath?: string;
  dryRun: boolean;
}

const README_OAUTH_URL =
  "https://github.com/amalodev/hubspot-conversations-mcp#per-user-oauth-team-setup";

const BROKER_GUIDE = `A broker is a small stateless service your org hosts (free on Vercel).
It holds your HubSpot app's client secret so employees never see it,
and exchanges/refreshes OAuth tokens — data traffic never touches it.

Setting one up takes ~10 minutes:
  1. Create a HubSpot app (private distribution, allowlist your portal,
     redirect http://localhost:4573/callback, conversations scopes)
  2. Click "Deploy with Vercel" in the README and enter the app's
     client ID + secret
  3. Come back here with the broker URL

Full guide: ${README_OAUTH_URL}`;

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

/** Unwrap a clack prompt result, exiting cleanly if the user pressed Ctrl+C/Esc. */
function ensureAnswered<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled — nothing was changed.");
    process.exit(1);
  }
  return value as T;
}

async function verifyBroker(
  brokerUrl: string,
): Promise<{ ok: true; clientId: string } | { ok: false; message: string }> {
  try {
    const response = await fetch(brokerEndpoint(brokerUrl, "config"), {
      signal: AbortSignal.timeout(8000),
    });
    const data = (await response.json().catch(() => ({}))) as { clientId?: string };
    if (response.ok && typeof data.clientId === "string" && data.clientId) {
      return { ok: true, clientId: data.clientId };
    }
    return {
      ok: false,
      message:
        response.status === 500
          ? "The broker responded but is missing its HUBSPOT_OAUTH_CLIENT_ID/SECRET env vars."
          : `The broker responded with status ${response.status} on /api/config.`,
    };
  } catch {
    return { ok: false, message: "Could not reach the broker — check the URL and your network." };
  }
}

async function askVerifiedBrokerUrl(): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const brokerUrl = ensureAnswered(
      await p.text({
        message: "Your org's broker URL",
        placeholder: "https://your-broker.vercel.app",
        initialValue: process.env.HUBSPOT_OAUTH_BROKER_URL?.trim() ?? "",
        validate: (value) => {
          if (!value?.trim()) return "The broker URL is required";
          try {
            new URL(value.trim());
            return undefined;
          } catch {
            return "Enter a full URL, e.g. https://your-broker.vercel.app";
          }
        },
      }),
    ).trim();

    const spinner = p.spinner();
    spinner.start(`Testing the broker at ${brokerUrl}`);
    const result = await verifyBroker(brokerUrl);
    if (result.ok) {
      spinner.stop(`Broker OK — serving client ID ${result.clientId.slice(0, 8)}…`);
      return brokerUrl;
    }
    spinner.stop("Broker test failed");
    p.log.error(result.message);
  }
  p.cancel(`Could not verify a broker after 3 attempts. See the setup guide: ${README_OAUTH_URL}`);
  process.exit(1);
}

export async function runSetup(flags: SetupFlags): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "setup is interactive — run it in a terminal. For scripted flows use " +
        "`login --broker-url <url>` followed by `install --client <selection>`.",
    );
  }

  p.intro(`${PACKAGE_NAME} v${SERVER_VERSION} — setup`);

  const hasBroker = ensureAnswered(
    await p.select({
      message: "Step 1/3 · Does your organization have an OAuth broker deployed?",
      options: [
        { value: "yes" as const, label: "Yes — I have the broker URL" },
        {
          value: "no" as const,
          label: "Not yet — show me how to set one up",
          hint: "~10 minutes, free",
        },
      ],
    }),
  );
  if (hasBroker === "no") {
    p.note(BROKER_GUIDE, "Set up your org's broker");
    p.log.info("When the broker is deployed, enter its URL below to continue.");
  }

  const brokerUrl = await askVerifiedBrokerUrl();

  p.log.step("Step 2/3 · Sign in with HubSpot — your browser will open the consent screen");
  try {
    await runLogin({
      brokerUrl,
      log: (message) => p.log.info(message),
      openBrowser: process.env.HUBSPOT_LOGIN_NO_OPEN?.trim() !== "1",
    });
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.cancel("Sign-in failed — nothing was installed.");
    process.exit(1);
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
      message: "Step 3/3 · Which agents should be configured? (↑/↓ to move, space to toggle, enter to confirm)",
      options: CLIENT_OPTIONS,
      initialValues: [...ALL_CLIENTS],
      required: true,
    }),
  );

  p.log.step(`Installing for: ${clients.join(", ")}${flags.dryRun ? " (dry-run)" : ""}`);
  const options: InstallOptions = {
    clients,
    senderActorId,
    // Setup registers Claude Code across all projects unless overridden.
    scope: flags.scope ?? "user",
    configPath: flags.configPath,
    hermesConfigPath: flags.hermesConfigPath,
    dryRun: flags.dryRun,
    log: (message) => p.log.info(message),
    logError: (message) => p.log.error(message),
  };
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
