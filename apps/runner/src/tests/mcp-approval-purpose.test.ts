// mcp-approval-purpose.test.ts — un outil MCP RÉEL, à travers la VRAIE porte,
// jusqu'à la ligne en base.
//
// Les trois morceaux vivent dans trois paquets : l'adaptateur pose `purpose` sur
// le schéma et le retire avant d'appeler le serveur
// (`packages/adapters/mcp/src/tests/tools.test.ts`), le gate refuse une demande
// muette (`packages/tools/src/tests/approval-purpose.test.ts`). Ce qu'aucun des
// deux ne prouve, et que la carte d'approbation lit pourtant : la phrase SURVIT
// à la ligne `approval_requests`. C'est ici, au seul endroit qui voit les trois.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq, approvalRequests } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal, type TestDb } from '@nodal-agents/db/test-utils';
import { mcpToolToToolDefinition } from '@nodal-agents/adapter-mcp';
import type { McpToolDescriptor } from '@nodal-agents/adapter-mcp';
import { executeTool } from '@nodal-agents/tools';
import type { ToolContext } from '@nodal-agents/tools';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

const descriptor: McpToolDescriptor = {
  name: 'get_home',
  description: 'Return the home view',
  inputSchema: { type: 'object', properties: { detail: { type: 'boolean' } } },
};

function ctx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

describe('un outil MCP gaté garde la raison de l’agent @cap:approuver-une-action/moteur', () => {
  it('la ligne d’approbation porte la phrase, et le serveur ne l’a jamais vue', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    // Le type du client vient de l'adaptateur : le runner ne dépend pas du SDK
    // MCP, et ce test n'a pas à l'ajouter pour fabriquer un faux.
    type McpClient = Parameters<typeof mcpToolToToolDefinition>[0];
    const def = mcpToolToToolDefinition({ callTool } as unknown as McpClient, descriptor, 'cogni');
    const phrase = 'Relire la page d’accueil avant de proposer un changement.';

    const result = await executeTool(def, { detail: true, purpose: phrase }, ctx(), {
      approvalRules: [],
      onApprovalRequired: async () => {},
    });

    // Un outil MCP est safe-by-default (MCP-001) : il suspend.
    expect(result.outcome).toBe('awaiting_approval');

    const rows = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.jobId, seed.jobId),
          eq(approvalRequests.toolName, 'cogni__get_home'),
        ),
      );
    expect(rows).toHaveLength(1);
    // Ce que la carte relira pour titrer la demande.
    const input = rows[0]?.toolInput as Record<string, unknown>;
    expect(input['purpose']).toBe(phrase);
    expect(input['detail']).toBe(true);

    // Suspendu : le serveur tiers n'a rien reçu du tout, phrase comprise.
    expect(callTool).not.toHaveBeenCalled();
  });
});
