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

  // Revue Codex de #492 : un serveur MCP peut prendre `purpose` comme un VRAI
  // argument. Deux purposes différents y sont deux appels différents, et le
  // second n'a jamais été vu par le propriétaire.
  it('a tool whose own argument is `purpose`: another purpose is another call, the same one is answered', async () => {
    const jobId = await newJob();
    const { tool, ran } = gatedTool('note_492_e');
    const owning = { ...tool, purposeIsArgument: true } as typeof tool;
    await executeTool(owning, { ...CALL, purpose: 'invoice' }, makeCtx(jobId), opts());
    const [asked] = await rowsFor(jobId, 'note_492_e');
    await reject(asked!.id);

    const contract = await executeTool(
      owning,
      { ...CALL, purpose: 'contract' },
      makeCtx(jobId),
      opts(),
    );
    expect(contract.outcome).toBe('awaiting_approval');
    expect(await rowsFor(jobId, 'note_492_e')).toHaveLength(2);

    const invoiceAgain = await executeTool(
      owning,
      { ...CALL, purpose: 'invoice' },
      makeCtx(jobId),
      opts(),
    );
    expect(invoiceAgain.outcome).toBe('error');
    expect(await rowsFor(jobId, 'note_492_e')).toHaveLength(2);
    expect(ran).toEqual([]);
  });

  // Revue Codex de #492, passe 2 : une décision couvre l'état où elle a été
  // prise. « Sauvegarde d'abord, puis supprime » : la sauvegarde faite, la même
  // suppression est une autre question, et le propriétaire doit la revoir.
  it('once the agent has done something else in the run, the identical call is put to the owner again', async () => {
    const jobId = await newJob();
    const { tool: del, ran } = gatedTool('delete_492_f');
    await executeTool(del, { ...CALL, purpose: 'Supprimer.' }, makeCtx(jobId), opts());
    const [asked] = await rowsFor(jobId, 'delete_492_f');
    await reject(asked!.id, "Sauvegarde d'abord, puis supprime.");

    // Tout de suite après : même appel, même réponse, aucune carte.
    const tooSoon = await executeTool(del, { ...CALL, purpose: 'Encore.' }, makeCtx(jobId), opts());
    expect(tooSoon.outcome).toBe('error');
    if (tooSoon.outcome === 'error') expect(tooSoon.error).toContain('something else');

    // La sauvegarde : un autre outil, qui s'exécute (pas de porte).
    const { tool: backup } = gatedTool('backup_492_f');
    const ungated = { ...backup, defaultApproval: undefined } as typeof backup;
    const saved = await executeTool(ungated, { ...CALL, purpose: 'Sauvegarde.' }, makeCtx(jobId), {
      ...opts(),
      approvalRules: [],
    });
    expect(saved.outcome).toBe('success');

    const afterBackup = await executeTool(
      del,
      { ...CALL, purpose: 'Sauvegardé.' },
      makeCtx(jobId),
      opts(),
    );
    expect(afterBackup.outcome).toBe('awaiting_approval');
    expect(await rowsFor(jobId, 'delete_492_f')).toHaveLength(2);
    expect(ran).toEqual([]);
  });

  // Revue Codex de #492, passe 3 : le MÊME appel, exécuté plus tard parce
  // qu'une règle l'a permis, a changé ce que le refus supposait.
  it('the identical call executed later (a rule allowed it) makes the old refusal stale', async () => {
    const jobId = await newJob();
    const { tool, ran } = gatedTool('delete_492_g');
    await executeTool(tool, { ...CALL, purpose: 'Supprimer.' }, makeCtx(jobId), opts());
    const [asked] = await rowsFor(jobId, 'delete_492_g');
    await reject(asked!.id);

    const allowed = await executeTool(tool, { ...CALL, purpose: 'Permis.' }, makeCtx(jobId), {
      ...opts(),
      approvalRules: [
        {
          id: 'rule-492-g',
          toolName: 'delete_492_g',
          action: 'auto_approve',
          agentId: seed.agentId,
          entityId: seed.entityId,
        },
      ],
    });
    expect(allowed.outcome).toBe('success');
    expect(ran).toHaveLength(1);

    // La règle retirée : la carte revient, le vieux refus ne répond plus.
    const again = await executeTool(tool, { ...CALL, purpose: 'Encore.' }, makeCtx(jobId), opts());
    expect(again.outcome).toBe('awaiting_approval');
    expect(await rowsFor(jobId, 'delete_492_g')).toHaveLength(2);
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
