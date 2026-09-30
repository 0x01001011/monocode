import { invoke } from "@tauri-apps/api/core";
import { parseClaudeMcpList, type McpConnection } from "./mcp";

export type McpServerRow = McpConnection & { status: string };

type McpSettingsSnapshot = {
  servers: McpServerRow[];
  error: string;
  claudeError: string;
};

const snapshots = new Map<string, McpSettingsSnapshot>();
const requests = new Map<string, Promise<McpSettingsSnapshot>>();

export function getCachedMcpSettings(cwd: string) {
  return snapshots.get(cwd);
}

/** Reuse the first load across navigation and StrictMode until explicitly refreshed. */
export function loadMcpSettings(cwd: string, force = false) {
  const cached = requests.get(cwd);
  if (cached && !force) return cached;

  const request = fetchMcpSettings(cwd).then((snapshot) => {
    // A newer refresh or cache clear supersedes this request.
    if (requests.get(cwd) === request) snapshots.set(cwd, snapshot);
    return snapshot;
  });
  requests.set(cwd, request);
  return request;
}

async function fetchMcpSettings(cwd: string): Promise<McpSettingsSnapshot> {
  try {
    const configured = await invoke<McpConnection[]>("mcp_discover", { cwd });
    let health = new Map<string, string>();
    let claudeError = "";
    try {
      const output = await invoke<string>("claude_mcp_list", { cwd });
      health = new Map(
        parseClaudeMcpList(output).map((server) => [
          server.name,
          server.status,
        ]),
      );
    } catch (cause) {
      claudeError = String(cause);
    }
    const servers: McpServerRow[] = configured.map((server) => ({
      ...server,
      status:
        server.provider === "claude"
          ? (health.get(server.name) ?? "Configured")
          : "Configured",
    }));
    // Claude can supply connections that are not stored in a local config file.
    for (const [name, status] of health) {
      if (
        servers.some(
          (server) => server.provider === "claude" && server.name === name,
        )
      )
        continue;
      servers.push({
        provider: "claude",
        name,
        scope: "local",
        configPath: "",
        transport: "",
        status,
      });
    }
    return { servers, error: "", claudeError };
  } catch (cause) {
    return { servers: [], error: String(cause), claudeError: "" };
  }
}

export function clearMcpSettingsCache() {
  snapshots.clear();
  requests.clear();
}
