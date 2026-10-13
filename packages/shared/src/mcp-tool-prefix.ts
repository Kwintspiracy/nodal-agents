/**
 * The prefix of every tool name a MCP server lends an agent: `my-server` →
 * `my_server`, so its `get_home` becomes `my_server__get_home`.
 *
 * Here rather than in `@nodal-agents/adapter-mcp` because two layers must
 * agree on it: the adapter, which names the tools, and the prompt, which reads
 * a job's tool list to know which servers the agent actually holds.
 */
export function mcpToolPrefix(slug: string): string {
  return slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}
