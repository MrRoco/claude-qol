// The state contract of the chat-ledger mod: what it keeps in `$.state` for
// the session. Names and counts only: never a tool's input or result, a
// command's arguments or an instruction file's text. Nothing here is written
// to disk, logs or the network.

export interface ConnectorTool {
  /** the tool's own name, without the `mcp__<server>__` prefix */
  name: string;
  calls: number;
}

export interface ConnectorEntry {
  /** the MCP server, as `/mcp` names it */
  server: string;
  /** every finished call, failed ones included */
  calls: number;
  failed: number;
  tools: ConnectorTool[];
}

export interface FileEntry {
  /** absolute path */
  path: string;
  read: number;
  edited: number;
  created: number;
}

export interface NameCount {
  name: string;
  count: number;
}

export interface ContextFile {
  /** absolute path */
  path: string;
  /** the instruction file's tier: managed, user, project, local, memory */
  kind: string;
}

declare module "claude-code" {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    "chat-ledger": {
      connectors: ConnectorEntry[];
      files: FileEntry[];
      skills: NameCount[];
      commands: NameCount[];
      contextFiles: ContextFile[];
      expanded: string[];
    };
  }
}
