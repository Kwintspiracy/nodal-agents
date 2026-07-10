// meta-ops/create-mcp.ts — create_mcp meta-tool
// Lets the ROOT agent provision a new MCP server in its entity.
//
// Fail-loud, no-write: the server is VERIFIED by actually connecting and
// listing its tools (ctx.provisioning.connectMcp, which throws on any
// connect/auth/spawn failure) BEFORE any row is written. Mirrors the dashboard
// "custom MCP" flow. Secrets (apiKey / env values) are encrypted at rest via
// the injected provisioning capability — packages/tools imports neither the MCP
// adapter nor the secrets package (those live in the runner-provided context).
//
// riskLevel 'write': additive. Approval is gated by the ROOT's autonomy level.

import { z } from 'zod';
import { eq, and } from '@nodal-agents/db';
import { mcpServers } from '@nodal-agents/db';
import type { ToolDefinition, ProvisionedMcpTool } from '../../types';
import { resolveAgentId, linkMcpToAgent } from './link-helpers';

const CreateMcpInput = z.object({
  name: z.string().min(1).describe('Human-readable display name for the MCP server.'),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens only.')
    .min(1)
    .describe('URL-safe identifier; also the tool-name prefix. Must be unique in this workspace.'),
  transport: z
    .enum(['http', 'stdio'])
    .describe('http = remote Streamable HTTP MCP server; stdio = local subprocess.'),
  // HTTP transport
  url: z.string().url().optional().describe('HTTP only: the MCP server endpoint URL.'),
  apiKey: z.string().optional().describe('HTTP only: API key/token used to authenticate.'),
  authScheme: z
    .enum(['header', 'query', 'bearer'])
    .optional()
    .describe(
      'HTTP only: how the key is sent — header, query param, or bearer. Defaults to header.',
    ),
  authParamName: z
    .string()
    .optional()
    .describe('HTTP only: the header or query-param name carrying the key (ignored for bearer).'),
  // stdio transport
  command: z.string().optional().describe('stdio only: the executable to spawn.'),
  args: z.array(z.string()).optional().describe('stdio only: command-line arguments.'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('stdio only: environment variables for the subprocess (encrypted at rest).'),
  attachToAgentSlug: z
    .string()
    .optional()
    .describe(
      'Optional: slug/name of an agent to immediately attach this MCP to, so its tools become ' +
        'usable by that agent. Without this, the server is registered but NOT usable by anyone ' +
        '— attach it later with attach_mcp.',
    ),
});

type CreateMcpOutput = { ok: true; message: string } | { ok: false; error: string };

export const createMcpTool: ToolDefinition<typeof CreateMcpInput, CreateMcpOutput> = {
  name: 'create_mcp',
  description:
    'Provision a new MCP server in this entity and make its tools available. ' +
    "BEFORE calling this, run skill_view('tool-create-mcp') to load the exact format + a worked " +
    'example (especially how to pass the API key — it goes in apiKey, never in the url). ' +
    'transport "http" needs url + apiKey (+ authScheme); "stdio" needs command (+ args, env). ' +
    'Pass attachToAgentSlug to immediately attach it to an agent (otherwise the server is ' +
    'registered but NO agent can use its tools — attach it after with attach_mcp). ' +
    'The server is verified by connecting and listing its tools BEFORE anything is saved — ' +
    'if it cannot connect, nothing is written and a clear error is returned. ' +
    'Fails if the slug is already used by another MCP server in this workspace.',
  inputSchema: CreateMcpInput,
  riskLevel: 'write',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const provisioning = ctx.provisioning;
    if (!provisioning) {
      return { ok: false, error: 'MCP provisioning is not available in this context.' };
    }

    // Optionally attach the new server to an agent so its tools become usable.
    // Returns a message suffix describing the outcome (the server is created
    // regardless; a missing target is reported, not fatal).
    const attachSuffix = async (mcpServerId: string): Promise<string> => {
      if (!input.attachToAgentSlug) {
        return ' (not attached to any agent yet — use attach_mcp to make its tools usable).';
      }
      const agentId = await resolveAgentId(ctx.db, ctx.entityId, input.attachToAgentSlug);
      if (!agentId) {
        return ` (note: could not attach — no agent "${input.attachToAgentSlug}" found; attach it later with attach_mcp).`;
      }
      await linkMcpToAgent(ctx.db, ctx.entityId, agentId, mcpServerId);
      return ` Attached to agent "${input.attachToAgentSlug}" — its tools are now available to that agent.`;
    };

    // Slug must be unique within the entity — it prefixes the server's tool names.
    const existing = await ctx.db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.entityId, ctx.entityId), eq(mcpServers.slug, input.slug)));
    if (existing.length > 0) {
      return {
        ok: false,
        error: `MCP slug "${input.slug}" is already used in this workspace. Choose a different slug.`,
      };
    }

    if (input.transport === 'http') {
      const url = (input.url ?? '').trim();
      const apiKey = (input.apiKey ?? '').trim();
      if (!url) return { ok: false, error: 'transport "http" requires a url.' };
      if (!apiKey) return { ok: false, error: 'transport "http" requires an apiKey.' };
      const authScheme = input.authScheme ?? 'header';
      const authParamName = authScheme === 'bearer' ? 'Authorization' : (input.authParamName ?? '');
      if (authScheme !== 'bearer' && !authParamName) {
        return {
          ok: false,
          error: `authParamName is required for the "${authScheme}" auth scheme.`,
        };
      }

      // Verify by connecting + listing tools — throws on any failure (no write).
      let tools: ProvisionedMcpTool[] = [];
      let conn: Awaited<ReturnType<typeof provisioning.connectMcp>> | null = null;
      try {
        conn = await provisioning.connectMcp({
          transport: 'http',
          url,
          apiKey,
          authScheme,
          authParamName,
        });
        tools = conn.tools;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Could not connect to MCP server at ${url}: ${msg}` };
      } finally {
        if (conn) await conn.close().catch(() => {});
      }

      const [insertedHttp] = await ctx.db
        .insert(mcpServers)
        .values({
          entityId: ctx.entityId,
          name: input.name,
          slug: input.slug,
          transport: 'http',
          url,
          apiKey: provisioning.encrypt(apiKey),
          apiKeyLast4: apiKey.slice(-4),
          authScheme,
          authParamName,
          availableTools: tools,
          active: true,
        })
        .returning({ id: mcpServers.id });
      const suffixHttp = insertedHttp ? await attachSuffix(insertedHttp.id) : '';
      return {
        ok: true,
        message: `Connected and registered MCP server "${input.name}" (${input.slug}) with ${tools.length} tool(s).${suffixHttp}`,
      };
    }

    // stdio transport
    const command = (input.command ?? '').trim();
    if (!command) return { ok: false, error: 'transport "stdio" requires a command.' };
    const args = input.args ?? [];
    const env = input.env ?? {};

    let tools: ProvisionedMcpTool[] = [];
    let conn: Awaited<ReturnType<typeof provisioning.connectMcp>> | null = null;
    try {
      conn = await provisioning.connectMcp({ transport: 'stdio', command, args, env });
      tools = conn.tools;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Could not start MCP subprocess "${command}": ${msg}` };
    } finally {
      if (conn) await conn.close().catch(() => {});
    }

    // Encrypt each env value individually for at-rest storage.
    const encEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) encEnv[k] = provisioning.encrypt(v);

    const [insertedStdio] = await ctx.db
      .insert(mcpServers)
      .values({
        entityId: ctx.entityId,
        name: input.name,
        slug: input.slug,
        transport: 'stdio',
        command,
        args,
        envVars: encEnv,
        availableTools: tools,
        active: true,
      })
      .returning({ id: mcpServers.id });
    const suffixStdio = insertedStdio ? await attachSuffix(insertedStdio.id) : '';
    return {
      ok: true,
      message: `Started and registered stdio MCP server "${input.name}" (${input.slug}) with ${tools.length} tool(s).${suffixStdio}`,
    };
  },
};
