// mcp-tool-cache.ts — the cache rule now lives in @nodal-agents/adapter-mcp
// (tool-cache.ts), next to McpToolDescriptor, so that the runner and the
// workflow bench read mcp_servers.available_tools with ONE rule. Re-exported
// here for the runner's existing imports.

export { isUsableMcpToolCache } from '@nodal-agents/adapter-mcp';
