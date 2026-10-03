// mcp-stdio-server.mjs — the smallest real MCP server, for tests.
//
// Built with the official SDK (`McpServer` + `StdioServerTransport`), launched
// by `node` as a stdio subprocess: what Nodal's client talks to here is a real
// MCP server over a real pipe, not a mock of the SDK. Plain JavaScript so any
// test can spawn it with `process.execPath` alone, without tsx.
//
// Configured through its environment, which is how a server row in
// `mcp_servers` configures it too (`env_vars`):
//   FIXTURE_MCP_NAME          the server's name (default `fixture`)
//   FIXTURE_MCP_INSTRUCTIONS  the `instructions` it publishes at initialize;
//                             absent or empty = it publishes none
//   FIXTURE_MCP_REPLY         what `ping` answers (default `pong`), so a test
//                             can tell two running servers apart
//
// One tool, `ping`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const instructions = process.env.FIXTURE_MCP_INSTRUCTIONS;

const server = new McpServer(
  { name: process.env.FIXTURE_MCP_NAME || 'fixture', version: '1.0.0' },
  instructions ? { instructions } : {},
);

const reply = process.env.FIXTURE_MCP_REPLY || 'pong';

server.registerTool('ping', { description: 'Answer pong.' }, async () => ({
  content: [{ type: 'text', text: reply }],
}));

await server.connect(new StdioServerTransport());
