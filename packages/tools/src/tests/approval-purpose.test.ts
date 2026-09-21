// approval-purpose.test.ts — une demande d'approbation sans raison n'existe pas.
//
// Constat de Quentin le 21/09/2026 : les cartes d'approbation disaient
// « L'agent n'a pas expliqué pourquoi » à répétition. La carte ne mentait pas —
// la plupart des outils gatés (tous les `meta-ops/*`, `declare_verification`,
// `run_schedule`) n'avaient aucun champ où le modèle aurait pu écrire sa raison.
//
// Ce que ces tests prouvent, sur la LIGNE EN BASE et jamais sur un compteur :
// une demande muette n'est pas posée du tout, et le modèle reçoit de quoi la
// reposer correctement.

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { eq, and } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { approvalRequests } from '@nodal-agents/db';
import { executeTool } from '../execute';
import type {
  ToolDefinition,
  ToolContext,
  ExecuteOptions,
  ApprovalGateRequest,
  ApprovalRule,
} from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    ...overrides,
  };
}

/** Les entrées réelles portées par les lignes d'approbation de CET outil. */
async function approvalInputsFor(toolName: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.jobId, seed.jobId), eq(approvalRequests.toolName, toolName)));
  return rows.map((r) => r.toolInput as Record<string, unknown>);
}

type Ran = { inputs: unknown[] };

/**
 * Un outil dont le schéma porte `purpose` en OPTIONNEL — la forme que
 * `exposeStatedPurpose` donne à un outil autonome, et celle qui laisse le gate
 * parler plutôt que la validation zod.
 */
function aTool(
  name: string,
  extra: Partial<ToolDefinition<z.ZodTypeAny, unknown>> = {},
): { tool: ToolDefinition<z.ZodTypeAny, unknown>; ran: Ran } {
  const ran: Ran = { inputs: [] };
  const tool = {
    name,
    description: 'tool under test',
    inputSchema: z.object({ path: z.string(), purpose: z.string().optional() }),
    riskLevel: 'write',
    async execute(input: unknown) {
      ran.inputs.push(input);
      return { ok: true };
    },
    ...extra,
  } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
  return { tool, ran };
}

function opts(rules: ApprovalRule[] = []): ExecuteOptions {
  const asked: ApprovalGateRequest[] = [];
  return {
    approvalRules: rules,
    onApprovalRequired: async (r) => {
      asked.push(r);
    },
  };
}

describe('la porte d’approbation exige la raison de l’agent @cap:approuver-une-action/moteur', () => {
  it('ne crée AUCUNE ligne d’approbation quand l’agent n’a pas dit pourquoi', async () => {
    const { tool, ran } = aTool('gated_no_reason', { defaultApproval: 'require_approval' });

    const result = await executeTool(tool, { path: '/tmp/a' }, makeCtx(), opts());

    // La ligne que la personne aurait dû lire n'existe pas.
    expect(await approvalInputsFor('gated_no_reason')).toEqual([]);
    // Et l'outil n'a rien exécuté non plus : refuser n'est pas laisser passer.
    expect(ran.inputs).toEqual([]);

    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      // Le texte est pour le MODÈLE : il nomme l'outil, le fait, et le geste.
      expect(result.error).toContain('approval_purpose_required');
      expect(result.error).toContain('gated_no_reason');
      expect(result.error).toContain('`purpose`');
      expect(result.error).toContain('one sentence');
    }
  });

  it('une raison faite d’espaces ne compte pas — la carte la lirait comme absente', async () => {
    const { tool } = aTool('gated_blank_reason', { defaultApproval: 'require_approval' });

    const result = await executeTool(tool, { path: '/tmp/a', purpose: '   ' }, makeCtx(), opts());

    expect(await approvalInputsFor('gated_blank_reason')).toEqual([]);
    expect(result.outcome).toBe('error');
  });

  it('avec la phrase, la ligne existe et PORTE la phrase, mot pour mot', async () => {
    const { tool, ran } = aTool('gated_with_reason', { defaultApproval: 'require_approval' });
    const phrase = 'Je dois lire le CHANGELOG pour dater la régression.';

    const result = await executeTool(tool, { path: '/tmp/a', purpose: phrase }, makeCtx(), opts());

    expect(result.outcome).toBe('awaiting_approval');
    const inputs = await approvalInputsFor('gated_with_reason');
    expect(inputs).toHaveLength(1);
    // C'est exactement ce que `explainApproval` relira pour titrer la carte.
    expect(inputs[0]?.['purpose']).toBe(phrase);
    expect(inputs[0]?.['path']).toBe('/tmp/a');
    // Suspendu, donc pas exécuté — la personne n'a pas encore répondu.
    expect(ran.inputs).toEqual([]);
  });

  it('un outil gaté par une RÈGLE, et non par sa posture, est tenu à la même règle', async () => {
    // Une lecture ordinaire que le propriétaire a décidé de surveiller.
    const { tool } = aTool('file_read_like');
    const rule: ApprovalRule = {
      id: 'r-read',
      toolName: 'file_read_like',
      action: 'require_approval',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const refus = await executeTool(tool, { path: '/tmp/a' }, makeCtx(), opts([rule]));
    expect(refus.outcome).toBe('error');
    expect(await approvalInputsFor('file_read_like')).toEqual([]);

    const ok = await executeTool(
      tool,
      { path: '/tmp/a', purpose: 'Relire le fichier avant de le corriger.' },
      makeCtx(),
      opts([rule]),
    );
    expect(ok.outcome).toBe('awaiting_approval');
    expect(await approvalInputsFor('file_read_like')).toHaveLength(1);
  });

  it('un appel AUTO-APPROUVÉ ne doit rien : il ne passe devant personne', async () => {
    const { tool, ran } = aTool('autonomous_tool');

    const result = await executeTool(tool, { path: '/tmp/a' }, makeCtx(), opts());

    expect(result.outcome).toBe('success');
    expect(ran.inputs).toEqual([{ path: '/tmp/a' }]);
  });

  it('un outil YOLO (règle auto_approve) reste exécutable sans phrase', async () => {
    const { tool, ran } = aTool('yolo_tool', { defaultApproval: 'require_approval' });
    const rule: ApprovalRule = {
      id: 'r-yolo',
      toolName: 'yolo_tool',
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const result = await executeTool(tool, { path: '/tmp/a' }, makeCtx(), opts([rule]));

    expect(result.outcome).toBe('success');
    expect(ran.inputs).toEqual([{ path: '/tmp/a' }]);
  });

  it('un appel BLOQUÉ garde son refus à lui — la raison n’aurait rien changé', async () => {
    const { tool } = aTool('blocked_tool', { defaultApproval: 'require_approval' });
    const rule: ApprovalRule = {
      id: 'r-block',
      toolName: 'blocked_tool',
      action: 'block',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const result = await executeTool(tool, { path: '/tmp/a' }, makeCtx(), opts([rule]));

    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toContain('blocked:');
      expect(result.error).not.toContain('approval_purpose_required');
    }
  });

  it('une QUESTION posée à la personne n’exige rien : son texte EST le message', async () => {
    // `ask_user` rend une carte qui montre la question, pas ce champ (voir
    // apps/web .../approvals/page.tsx, branche kind === 'question'). Exiger un
    // « pourquoi » séparé y ferait écrire deux fois la même phrase.
    const ran: Ran = { inputs: [] };
    const tool = {
      name: 'ask_user_like',
      description: 'asks',
      inputSchema: z.object({ question: z.string() }),
      riskLevel: 'read',
      asksUser: true,
      async execute(input: unknown) {
        ran.inputs.push(input);
        return { ok: true };
      },
    } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;

    const result = await executeTool(
      tool,
      { question: 'Quelle version publier ?' },
      makeCtx({ toolCallId: 'call-q-1' }),
      opts(),
    );

    expect(result.outcome).toBe('awaiting_approval');
    const inputs = await approvalInputsFor('ask_user_like');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.['question']).toBe('Quelle version publier ?');
  });
});
