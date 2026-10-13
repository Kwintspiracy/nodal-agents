// server-instructions.test.ts — the `instructions` an MCP server publishes at
// initialize reach whoever connected, on the eager AND the lazy path.
//
// No mock here: Nodal's real client spawns a real MCP server (the SDK-built
// fixture in ./fixtures) over stdio. The SDK keeps the field
// (`Client.getInstructions()`); before this, `McpConnection` dropped it and
// nothing in Nodal ever read it.

import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { connectMcp, createLazyMcpTools, createMcpTools } from '../index.ts';
import type { McpServerDiscovery } from '../index.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url));

const GUIDE = 'Call ping before anything else.\nNever call ping twice in a row.';

function stdio(env: Record<string, string>) {
  return { transport: 'stdio' as const, command: process.execPath, args: [FIXTURE], env };
}

describe('MCP server instructions @cap:connecter-un-service/moteur', () => {
  it('connectMcp returns the instructions a real server published, verbatim', async () => {
    const conn = await connectMcp(stdio({ FIXTURE_MCP_INSTRUCTIONS: GUIDE }));
    try {
      expect(conn.instructions).toBe(GUIDE);
      expect(conn.tools.map((t) => t.name)).toEqual(['ping']);
    } finally {
      await conn.close();
    }
  }, 30_000);

  it('keeps the whitespace of a published text: an indented code block stays a code block', async () => {
    const indented = '    list_printers\n    request_print\n\nThen show the card.\n';
    const conn = await connectMcp(stdio({ FIXTURE_MCP_INSTRUCTIONS: indented }));
    try {
      expect(conn.instructions).toBe(indented);
    } finally {
      await conn.close();
    }
  }, 30_000);

  it('whitespace alone is no guidance: null', async () => {
    const conn = await connectMcp(stdio({ FIXTURE_MCP_INSTRUCTIONS: ' \n\t ' }));
    try {
      expect(conn.instructions).toBeNull();
    } finally {
      await conn.close();
    }
  }, 30_000);

  it('a server that publishes none yields null, not an empty string', async () => {
    const conn = await connectMcp(stdio({}));
    try {
      expect(conn.instructions).toBeNull();
    } finally {
      await conn.close();
    }
  }, 30_000);

  it('the eager toolset carries them next to its descriptors', async () => {
    const toolset = await createMcpTools({
      ...stdio({ FIXTURE_MCP_INSTRUCTIONS: GUIDE }),
      slug: 'guide',
    });
    try {
      expect(toolset.instructions).toBe(GUIDE);
      expect(toolset.descriptors.map((d) => d.name)).toEqual(['ping']);
    } finally {
      await toolset.close();
    }
  }, 30_000);

  it('the lazy toolset hands the live tools AND instructions to onConnected at first call', async () => {
    const seen: McpServerDiscovery[] = [];
    const toolset = createLazyMcpTools(
      { ...stdio({ FIXTURE_MCP_INSTRUCTIONS: GUIDE }), slug: 'guide' },
      [{ name: 'ping', description: 'Answer pong.', inputSchema: { type: 'object' } }],
      { onConnected: (live) => void seen.push(live) },
    );
    try {
      const [ping] = toolset.tools;
      const result = await ping!.execute({}, {} as never);
      expect(JSON.stringify(result)).toContain('pong');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.instructions).toBe(GUIDE);
      expect(seen[0]!.tools.map((t) => t.name)).toEqual(['ping']);
    } finally {
      await toolset.close();
    }
  }, 30_000);
});
