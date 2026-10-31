// fake-mcp-serve.mjs — un serveur MCP de test, démarré par le VRAI startRunTask.
//
// Il note ce que le banc lui a réellement passé (les variantes de
// NODAL_MCP_AGENT_ID dans son environnement, les arguments de run_task) dans
// le fichier que BENCH_FAKE_MCP_OUT nomme, et répond comme `nodal-agents mcp
// serve` : un job créé.
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-nodal', version: '1' });
server.registerTool(
  'run_task',
  {
    description: 'test double',
    inputSchema: {
      instruction: z.string(),
      caller: z.string(),
      agent: z.string().optional(),
      expectedWorkspaceId: z.string().optional(),
    },
  },
  async (args) => {
    const pinned = Object.entries(process.env).filter(
      ([k]) => k.toUpperCase() === 'NODAL_MCP_AGENT_ID',
    );
    writeFileSync(process.env.BENCH_FAKE_MCP_OUT, JSON.stringify({ pinned, args }));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ jobId: '11111111-1111-4111-8111-111111111111', status: 'queued' }),
        },
      ],
    };
  },
);
// get_task, comme `nodal-agents mcp serve` (#887) : il note l'id relu, et rend
// le job tel que le serveur le lirait en base.
server.registerTool(
  'get_task',
  {
    description: 'test double',
    inputSchema: { jobId: z.string(), waitSeconds: z.number().optional() },
  },
  async (args) => {
    writeFileSync(`${process.env.BENCH_FAKE_MCP_OUT}.get`, JSON.stringify({ args }));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            jobId: args.jobId,
            status: 'completed',
            jobStatus: 'completed',
            result: 'Canberra.',
            error: null,
            liveJobs: 0,
            deliverables: [],
            waitingForPerson: [],
          }),
        },
      ],
    };
  },
);
await server.connect(new StdioServerTransport());
