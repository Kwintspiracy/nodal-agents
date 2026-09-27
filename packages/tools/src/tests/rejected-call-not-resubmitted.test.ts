// rejected-call-not-resubmitted.test.ts — un appel refusé n'est pas reposé à
// l'identique dans le même run (issue #492).
//
// Job b49d7d96 (25/09/2026) : le propriétaire refuse un `generate_speech`
// (approbation 34af576e). Vingt-six secondes plus tard, l'agent renvoie le
// MÊME appel — même chemin, même texte, même voix — avec seulement son
// `purpose` reformulé, et le propriétaire reçoit une seconde carte. La porte
// répond désormais depuis la décision déjà prise : aucune nouvelle ligne, et
// le modèle apprend que ce refus tient.
//
// Tout se lit sur les LIGNES `approval_requests` et sur le résultat rendu au
// modèle, jamais sur un compteur d'appels.

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { eq, and } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { approvalRequests, agentJobs } from '@nodal-agents/db';
import { executeTool } from '../execute';
import type { ToolDefinition, ToolContext, ExecuteOptions } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

function makeCtx(jobId: string): ToolContext {
  return {
    jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

function gatedTool(name: string): { tool: ToolDefinition<z.ZodTypeAny, unknown>; ran: unknown[] } {
  const ran: unknown[] = [];
  const tool = {
    name,
    description: 'tool under test',
    inputSchema: z.object({
      path: z.string(),
      text: z.string(),
      voice: z.string().optional(),
      purpose: z.string().optional(),
    }),
    riskLevel: 'write',
    defaultApproval: 'require_approval',
    async execute(input: unknown) {
      ran.push(input);
      return { ok: true };
    },
  } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
  return { tool, ran };
}

function opts(): ExecuteOptions {
  return { approvalRules: [], onApprovalRequired: async () => {} };
}

async function newJob(): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'voice-over',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function rowsFor(jobId: string, toolName: string) {
  return db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.jobId, jobId), eq(approvalRequests.toolName, toolName)));
}

async function reject(id: string, notes: string | null = null): Promise<void> {
  await db
    .update(approvalRequests)
    .set({ status: 'rejected', resolvedAt: new Date(), notes })
    .where(eq(approvalRequests.id, id));
}

const CALL = {
  path: 'shared/outputs/voiceover-agentic-harness.wav',
  text: 'Bonjour.',
  voice: 'alloy',
};

describe('an identical call the owner already rejected in this run (#492) @cap:approuver-une-action/moteur', () => {
  it('is answered from that decision: no second card, nothing executed, the model is told', async () => {
    const jobId = await newJob();
    const { tool, ran } = gatedTool('speech_492_a');

    const first = await executeTool(
      tool,
      { ...CALL, purpose: 'Générer le voice-over TTS.' },
      makeCtx(jobId),
      opts(),
    );
    expect(first.outcome).toBe('awaiting_approval');
    const [asked] = await rowsFor(jobId, 'speech_492_a');
    await reject(asked!.id, 'pas maintenant');

    // Le même appel, clés dans un autre ordre, purpose reformulé.
    const again = await executeTool(
      tool,
      {
        voice: 'alloy',
        purpose: 'Voice-over TTS du script fourni.',
        text: 'Bonjour.',
        path: CALL.path,
      },
      makeCtx(jobId),
      opts(),
    );

    expect(await rowsFor(jobId, 'speech_492_a')).toHaveLength(1);
    expect(ran).toEqual([]);
    expect(again.outcome).toBe('error');
    if (again.outcome === 'error') {
      expect(again.error).toContain('approval_already_rejected');
      expect(again.error).toContain(asked!.id);
      expect(again.error).toContain('pas maintenant');
    }
  });

  it('a call that differs by more than its purpose is a new request', async () => {
    const jobId = await newJob();
    const { tool } = gatedTool('speech_492_b');
    await executeTool(tool, { ...CALL, purpose: 'Premier essai.' }, makeCtx(jobId), opts());
    const [asked] = await rowsFor(jobId, 'speech_492_b');
    await reject(asked!.id);

    const other = await executeTool(
      tool,
      { ...CALL, text: 'Bonsoir.', purpose: 'Autre texte.' },
      makeCtx(jobId),
      opts(),
    );

    expect(other.outcome).toBe('awaiting_approval');
    expect(await rowsFor(jobId, 'speech_492_b')).toHaveLength(2);
  });

  it('another run asking the same call is asked again: the decision belongs to its run', async () => {
    const { tool } = gatedTool('speech_492_c');
    const runA = await newJob();
    await executeTool(tool, { ...CALL, purpose: 'Run A.' }, makeCtx(runA), opts());
    const [asked] = await rowsFor(runA, 'speech_492_c');
    await reject(asked!.id);

    const runB = await newJob();
    const inB = await executeTool(tool, { ...CALL, purpose: 'Run B.' }, makeCtx(runB), opts());

    expect(inB.outcome).toBe('awaiting_approval');
    expect(await rowsFor(runB, 'speech_492_c')).toHaveLength(1);
  });

  it('an EXPIRED request is not a refusal: asking again is allowed', async () => {
    const jobId = await newJob();
    const { tool } = gatedTool('speech_492_d');
    await executeTool(tool, { ...CALL, purpose: 'Premier essai.' }, makeCtx(jobId), opts());
    const [asked] = await rowsFor(jobId, 'speech_492_d');
    await db
      .update(approvalRequests)
      .set({ status: 'expired' })
      .where(eq(approvalRequests.id, asked!.id));

    const again = await executeTool(tool, { ...CALL, purpose: 'Encore.' }, makeCtx(jobId), opts());

    expect(again.outcome).toBe('awaiting_approval');
  });
});
