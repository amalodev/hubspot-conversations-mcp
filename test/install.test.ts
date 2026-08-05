import { describe, expect, it } from "vitest";
import {
  buildServerEntry,
  claudeCodeCommand,
  defaultDesktopConfigPath,
  defaultHermesConfigPath,
  mergeDesktopConfig,
  mergeHermesConfig,
  parseClientSelection,
} from "../src/install.js";

describe("parseClientSelection", () => {
  it("selects all clients for empty/all/alle", () => {
    const all = ["claude-desktop", "claude-code", "hermes"];
    expect(parseClientSelection("")).toEqual(all);
    expect(parseClientSelection("all")).toEqual(all);
    expect(parseClientSelection("alle")).toEqual(all);
  });

  it("keeps 'both' meaning the two Claude clients", () => {
    expect(parseClientSelection("both")).toEqual(["claude-desktop", "claude-code"]);
  });

  it("accepts numbers, names and mixes, deduplicated", () => {
    expect(parseClientSelection("1,3")).toEqual(["claude-desktop", "hermes"]);
    expect(parseClientSelection("claude-code, hermes")).toEqual(["claude-code", "hermes"]);
    expect(parseClientSelection("2 2 code")).toEqual(["claude-code"]);
    expect(parseClientSelection("Desktop")).toEqual(["claude-desktop"]);
  });

  it("rejects unknown clients", () => {
    expect(() => parseClientSelection("cursor")).toThrow(/Unknown client "cursor"/);
  });
});

describe("buildServerEntry", () => {
  it("uses npx -y with the package name", () => {
    expect(buildServerEntry("pat-1")).toEqual({
      command: "npx",
      args: ["-y", "hubspot-conversations-mcp"],
      env: { HUBSPOT_ACCESS_TOKEN: "pat-1" },
    });
  });

  it("includes the sender actor when provided", () => {
    expect(buildServerEntry("pat-1", "A-42").env).toEqual({
      HUBSPOT_ACCESS_TOKEN: "pat-1",
      HUBSPOT_DEFAULT_SENDER_ACTOR_ID: "A-42",
    });
  });

  it("omits the token env in OAuth mode (server uses the local token store)", () => {
    expect(buildServerEntry(undefined, "A-42").env).toEqual({
      HUBSPOT_DEFAULT_SENDER_ACTOR_ID: "A-42",
    });
    expect(buildServerEntry().env).toEqual({});
  });
});

describe("mergeDesktopConfig", () => {
  const entry = buildServerEntry("pat-1");

  it("creates the structure from scratch", () => {
    expect(mergeDesktopConfig(undefined, entry)).toEqual({
      mcpServers: { "hubspot-conversations": entry },
    });
  });

  it("preserves other servers and top-level settings", () => {
    const existing = {
      theme: "dark",
      mcpServers: { other: { command: "other-server" } },
    };
    const merged = mergeDesktopConfig(existing, entry);
    expect(merged.theme).toBe("dark");
    expect((merged.mcpServers as Record<string, unknown>).other).toEqual({
      command: "other-server",
    });
    expect((merged.mcpServers as Record<string, unknown>)["hubspot-conversations"]).toEqual(entry);
  });

  it("replaces a previous registration of the same server", () => {
    const existing = {
      mcpServers: { "hubspot-conversations": { command: "node", args: ["/old/path.js"] } },
    };
    const merged = mergeDesktopConfig(existing, entry);
    expect((merged.mcpServers as Record<string, unknown>)["hubspot-conversations"]).toEqual(entry);
  });

  it("recovers from malformed existing content", () => {
    expect(mergeDesktopConfig("garbage", entry)).toEqual({
      mcpServers: { "hubspot-conversations": entry },
    });
    expect(mergeDesktopConfig({ mcpServers: [1, 2] }, entry)).toEqual({
      mcpServers: { "hubspot-conversations": entry },
    });
  });
});

describe("mergeHermesConfig", () => {
  const entry = buildServerEntry("pat-1", "A-42");

  it("creates the mcp_servers map from scratch with enabled: true", () => {
    expect(mergeHermesConfig(undefined, entry)).toEqual({
      mcp_servers: { "hubspot-conversations": { ...entry, enabled: true } },
    });
  });

  it("preserves other Hermes settings and servers", () => {
    const existing = {
      model: "hermes-4",
      mcp_servers: { filesystem: { command: "npx", args: ["-y", "fs-server"] } },
    };
    const merged = mergeHermesConfig(existing, entry);
    expect(merged.model).toBe("hermes-4");
    const servers = merged.mcp_servers as Record<string, unknown>;
    expect(servers.filesystem).toEqual({ command: "npx", args: ["-y", "fs-server"] });
    expect(servers["hubspot-conversations"]).toEqual({ ...entry, enabled: true });
  });
});

describe("default config paths", () => {
  it("resolves the desktop path per platform", () => {
    expect(defaultDesktopConfigPath("darwin", {})).toContain(
      "Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(defaultDesktopConfigPath("win32", { APPDATA: "C:\\Users\\k\\AppData\\Roaming" })).toContain(
      "Claude",
    );
    expect(defaultDesktopConfigPath("linux", { XDG_CONFIG_HOME: "/home/k/.config" })).toBe(
      "/home/k/.config/Claude/claude_desktop_config.json",
    );
  });

  it("resolves the Hermes path with env override", () => {
    expect(defaultHermesConfigPath({})).toContain(".hermes/config.yaml");
    expect(defaultHermesConfigPath({ HERMES_CONFIG_PATH: "/tmp/h.yaml" })).toBe("/tmp/h.yaml");
  });
});

describe("claudeCodeCommand", () => {
  it("builds the claude mcp add invocation with npx", () => {
    expect(claudeCodeCommand({ token: "pat-1" })).toEqual([
      "mcp",
      "add",
      "hubspot-conversations",
      "--env",
      "HUBSPOT_ACCESS_TOKEN=pat-1",
      "--",
      "npx",
      "-y",
      "hubspot-conversations-mcp",
    ]);
  });

  it("includes scope and sender actor when provided", () => {
    const args = claudeCodeCommand({ token: "pat-1", senderActorId: "A-42", scope: "user" });
    expect(args).toContain("-s");
    expect(args).toContain("user");
    expect(args).toContain("HUBSPOT_DEFAULT_SENDER_ACTOR_ID=A-42");
  });

  it("omits the token env flag in OAuth mode", () => {
    const args = claudeCodeCommand({ scope: "user" });
    expect(args.join(" ")).not.toContain("HUBSPOT_ACCESS_TOKEN");
    expect(args).toEqual([
      "mcp",
      "add",
      "-s",
      "user",
      "hubspot-conversations",
      "--",
      "npx",
      "-y",
      "hubspot-conversations-mcp",
    ]);
  });
});
