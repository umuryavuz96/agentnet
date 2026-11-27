/** What the agentnet mod keeps in `$.state` (the session's own values), by the server name /mcp lists: the MCP servers
 *  the owner switched off for this session, and every server met so far. */
export type McpNames = string[];

declare module 'claude-code' {
  interface PluginState {
    agentnet: { mcpOff: McpNames; mcpSeen: McpNames }
  }
}
