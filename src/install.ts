import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const PACKAGE_NAME = "hubspot-conversations-mcp";
export const MCP_SERVER_KEY = "hubspot-conversations";

export type ClientId = "claude-desktop" | "claude-code" | "hermes";

export const ALL_CLIENTS: ClientId[] = ["claude-desktop", "claude-code", "hermes"];

export interface InstallOptions {
  clients: ClientId[];
  senderActorId?: string;
  /** claude mcp add scope: local, user, or project */
  scope?: string;
  /** Override the claude_desktop_config.json location */
  configPath?: string;
  /** Override the Hermes config.yaml location */
  hermesConfigPath?: string;
  dryRun: boolean;
  /** Progress output; defaults to console.log (the setup wizard routes these through its UI) */
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Parse a client selection such as "both", "all", "claude-code,hermes" or the
 * wizard's numeric answers ("1,3"). An empty string selects every client.
 */
export function parseClientSelection(raw: string): ClientId[] {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all" || trimmed === "alle" || trimmed === "a") {
    return [...ALL_CLIENTS];
  }
  if (trimmed === "both") return ["claude-desktop", "claude-code"];

  const aliases: Record<string, ClientId> = {
    "1": "claude-desktop",
    "claude-desktop": "claude-desktop",
    desktop: "claude-desktop",
    "2": "claude-code",
    "claude-code": "claude-code",
    code: "claude-code",
    "3": "hermes",
    hermes: "hermes",
  };

  const selected: ClientId[] = [];
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const client = aliases[token];
    if (!client) {
      throw new Error(
        `Unknown client "${token}". Valid: claude-desktop (1), claude-code (2), hermes (3), both, all.`,
      );
    }
    if (!selected.includes(client)) selected.push(client);
  }
  if (selected.length === 0) return [...ALL_CLIENTS];
  return selected;
}

/** Entries carry no credentials — the server reads the per-user OAuth token store. */
export function buildServerEntry(senderActorId?: string): ServerEntry {
  const env: Record<string, string> = {};
  if (senderActorId) env.HUBSPOT_DEFAULT_SENDER_ACTOR_ID = senderActorId;
  return { command: "npx", args: ["-y", PACKAGE_NAME], env };
}

function backupIfExists(filePath: string, log: (message: string) => void): void {
  if (existsSync(filePath)) {
    const backupPath = `${filePath}.backup-${Date.now()}`;
    copyFileSync(filePath, backupPath);
    log(`Backed up existing config to ${backupPath}`);
  }
}

// --- Claude Desktop ---------------------------------------------------------

export function defaultDesktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  const configHome = env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  return path.join(configHome, "Claude", "claude_desktop_config.json");
}

/** Merge the server entry into an existing claude_desktop_config.json structure. */
export function mergeDesktopConfig(existing: unknown, entry: ServerEntry): Record<string, unknown> {
  const config: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const servers: Record<string, unknown> =
    config.mcpServers !== null &&
    typeof config.mcpServers === "object" &&
    !Array.isArray(config.mcpServers)
      ? { ...(config.mcpServers as Record<string, unknown>) }
      : {};
  servers[MCP_SERVER_KEY] = entry;
  config.mcpServers = servers;
  return config;
}

export function installClaudeDesktop(options: InstallOptions): void {
  const log = options.log ?? console.log;
  const configPath = options.configPath ?? defaultDesktopConfigPath();
  let existing: unknown;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    try {
      existing = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `${configPath} contains invalid JSON — fix or remove it first: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  const merged = mergeDesktopConfig(existing, buildServerEntry(options.senderActorId));
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  if (options.dryRun) {
    log(`[dry-run] Would write ${configPath}:\n${serialized}`);
    return;
  }

  mkdirSync(path.dirname(configPath), { recursive: true });
  backupIfExists(configPath, log);
  writeFileSync(configPath, serialized);
  log(`✔ Claude Desktop: registered "${MCP_SERVER_KEY}" in ${configPath}`);
  log("  Restart Claude Desktop to load the server.");
}

// --- Claude Code -------------------------------------------------------------

export function claudeCodeCommand(options: {
  senderActorId?: string;
  scope?: string;
}): string[] {
  const args = ["mcp", "add"];
  if (options.scope) args.push("-s", options.scope);
  args.push(MCP_SERVER_KEY);
  if (options.senderActorId) {
    args.push("--env", `HUBSPOT_DEFAULT_SENDER_ACTOR_ID=${options.senderActorId}`);
  }
  args.push("--", "npx", "-y", PACKAGE_NAME);
  return args;
}

export function claudeCodeRemoveCommand(scope?: string): string[] {
  const args = ["mcp", "remove"];
  if (scope) args.push("-s", scope);
  args.push(MCP_SERVER_KEY);
  return args;
}

export function installClaudeCode(options: InstallOptions): void {
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  const args = claudeCodeCommand(options);
  const printable = `claude ${args
    .map((arg) => (arg.includes(" ") || arg.includes("=") ? JSON.stringify(arg) : arg))
    .join(" ")}`;

  if (options.dryRun) {
    log(`[dry-run] Would run: ${printable} (removing any existing registration first)`);
    return;
  }

  // Reinstall semantics: drop any existing registration so reruns just work.
  spawnSync("claude", claudeCodeRemoveCommand(options.scope), { stdio: "ignore" });

  const result = spawnSync("claude", args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    logError(`Could not run the claude CLI automatically. Run this yourself:\n  ${printable}`);
    if (result.error) process.exitCode = 1;
    return;
  }
  log(`✔ Claude Code: registered "${MCP_SERVER_KEY}" via the claude CLI`);
}

// --- Hermes (Nous Research hermes-agent) -------------------------------------

export function defaultHermesConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERMES_CONFIG_PATH?.trim()) return env.HERMES_CONFIG_PATH.trim();
  return path.join(homedir(), ".hermes", "config.yaml");
}

/**
 * Merge the server entry into Hermes' config.yaml structure, where
 * `mcp_servers` is a map keyed by server name.
 */
export function mergeHermesConfig(existing: unknown, entry: ServerEntry): Record<string, unknown> {
  const config: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const servers: Record<string, unknown> =
    config.mcp_servers !== null &&
    typeof config.mcp_servers === "object" &&
    !Array.isArray(config.mcp_servers)
      ? { ...(config.mcp_servers as Record<string, unknown>) }
      : {};
  servers[MCP_SERVER_KEY] = { ...entry, enabled: true };
  config.mcp_servers = servers;
  return config;
}

export function installHermes(options: InstallOptions): void {
  const log = options.log ?? console.log;
  const configPath = options.hermesConfigPath ?? defaultHermesConfigPath();
  let existing: unknown;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    try {
      existing = raw.trim() === "" ? {} : parseYaml(raw);
    } catch (error) {
      throw new Error(
        `${configPath} contains invalid YAML — fix or remove it first: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  const merged = mergeHermesConfig(existing, buildServerEntry(options.senderActorId));
  const serialized = stringifyYaml(merged);

  if (options.dryRun) {
    log(`[dry-run] Would write ${configPath}:\n${serialized}`);
    return;
  }

  mkdirSync(path.dirname(configPath), { recursive: true });
  backupIfExists(configPath, log);
  writeFileSync(configPath, serialized);
  log(`✔ Hermes: registered "${MCP_SERVER_KEY}" in ${configPath}`);
  log(
    `  Note: rewriting the YAML drops any comments (a backup was made). ` +
      `Verify with \`hermes mcp test ${MCP_SERVER_KEY}\` or /reload-mcp in a running session.`,
  );
}

// --- Orchestration -----------------------------------------------------------

const INSTALLERS: Record<ClientId, (options: InstallOptions) => void> = {
  "claude-desktop": installClaudeDesktop,
  "claude-code": installClaudeCode,
  hermes: installHermes,
};

export function runInstall(options: InstallOptions): void {
  for (const client of options.clients) {
    INSTALLERS[client](options);
  }
}
