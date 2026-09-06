// ask-user.test.ts — `ask_user` suspend le travail, et seule une réponse en
// base le fait repartir (P10a, plan « De la maquette au produit »).
//
// Ce qui est prouvé ici tient en une phrase : la question passe par la MÊME
// porte que les approbations, mais aucun réglage d'autonomie ne la saute. Les
// assertions portent sur les LIGNES relues (`approval_requests`, `tool_calls`)
// et sur la sortie réelle de l'outil, jamais sur des compteurs d'appels.

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, desc, isNull } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { approvalRequests, toolCalls } from '@nodal-agents/db';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { executeTool } from '../../execute';
import { askUserTool } from '../../builtin/ask-user';
import { ALWAYS_ON_TOOLS } from '../../builtin/index';
import type { ToolContext, ExecuteOptions, ApprovalRule } from '../../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

const QUESTION = {
  question: 'Where should I write the summary?',
  options: ['The repo README', 'A new file in notes'],
  context: 'Both already exist; the README is tracked by git.',
};

function makeCtx(toolCallId: string | undefined): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

/** La règle synthétique que le runner passe à la reprise (job/execute.ts). */
function resumeBypassRule(): ApprovalRule {
  return {
    id: 'resume-bypass',
    entityId: seed.entityId,
    agentId: null,
    toolName: 'ask_user',
    action: 'auto_approve',
  };
}

function makeOpts(
  rules: ApprovalRule[] = [],
  autonomy?: ExecuteOptions['autonomy'],
): ExecuteOptions {
  return {
    approvalRules: rules,
    ...(autonomy === undefined ? {} : { autonomy }),
    onApprovalRequired: async () => {},
  };
}

async function latestApproval(toolCallId: string) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.jobId, seed.jobId), eq(approvalRequests.toolCallId, toolCallId)))
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(1);
  return row;
}

async function latestToolCall(toolCallId: string) {
  const rows = await db
    .select()
    .from(toolCalls)
    .where(and(eq(toolCalls.jobId, seed.jobId), eq(toolCalls.toolCallId, toolCallId)))
    .orderBy(toolCalls.createdAt);
  return rows;
}

describe('ask_user — la porte', () => {
  it("suspend même sous une règle auto_approve EXPLICITE et fully_autonomous, et écrit une ligne de kind 'question'", async () => {
    const callId = 'call-ask-1';
    const result = await executeTool(
      askUserTool,
      QUESTION,
      makeCtx(callId),
      makeOpts(
        [
          {
            id: 'yolo',
            entityId: seed.entityId,
            agentId: seed.agentId,
            toolName: 'ask_user',
            action: 'auto_approve',
          },
        ],
        'fully_autonomous',
      ),
    );

    expect(result.outcome).toBe('awaiting_approval');

    const row = await latestApproval(callId);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('question');
    expect(row?.status).toBe('pending');
    expect(row?.answer).toBeNull();
    expect(row?.toolName).toBe('ask_user');
    expect(row?.toolInput).toMatchObject({
      question: QUESTION.question,
      options: QUESTION.options,
      context: QUESTION.context,
    });

    const calls = await latestToolCall(callId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.card).toBe('question');
  });

  it("sans toolCallId, refuse par un code — ni réponse au hasard, ni question qu'on ne saurait reprendre", async () => {
    // Une ligne répondue existe pour le job — mais pour un AUTRE appel. Sans id
    // d'appel, rien ne permet de dire qu'elle répond à celle-ci ; et suspendre
    // créerait une ligne SANS id que la reprise ne retrouverait jamais — la
    // question serait reposée à l'infini (revue Codex, passe 37).
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'ask_user',
      toolInput: QUESTION,
      toolCallId: 'call-someone-else',
      kind: 'question',
      status: 'approved',
      answer: QUESTION.options[1]!,
    });

    const result = await executeTool(
      askUserTool,
      QUESTION,
      makeCtx(undefined),
      makeOpts([resumeBypassRule()], 'fully_autonomous'),
    );

    expect(result).toEqual({ outcome: 'error', error: 'question_without_call_id' });
    // Aucune ligne sans id n'a été créée : rien à reprendre, rien à reposer.
    const sansId = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, seed.jobId), isNull(approvalRequests.toolCallId)));
    expect(sansId).toEqual([]);
  });

  it("une règle `block` est honorée : bloqué, et AUCUNE ligne d'approbation", async () => {
    const callId = 'call-ask-blocked';
    const result = await executeTool(
      askUserTool,
      QUESTION,
      makeCtx(callId),
      makeOpts([
        {
          id: 'blocked',
          entityId: seed.entityId,
          agentId: seed.agentId,
          toolName: 'ask_user',
          action: 'block',
        },
      ]),
    );

    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') expect(result.error).toContain('blocked');
    expect(await latestApproval(callId)).toBeUndefined();
  });
});

describe('ask_user — la reprise', () => {
  it('une ligne approuvée rend la réponse et son rang, et la carte porte la réponse', async () => {
    const callId = 'call-ask-answered';
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'ask_user',
      toolInput: QUESTION,
      toolCallId: callId,
      kind: 'question',
      status: 'approved',
      answer: QUESTION.options[1]!,
      resolvedAt: new Date(),
    });

    const result = await executeTool(
      askUserTool,
      QUESTION,
      makeCtx(callId),
      makeOpts([resumeBypassRule()]),
    );

    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(result.output).toEqual({ answer: QUESTION.options[1], option_index: 1 });
    }

    const calls = await latestToolCall(callId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.card).toBe('question');
    expect(calls[0]?.presented).toMatchObject({
      card: 'question',
      prompt: QUESTION.question,
      options: QUESTION.options,
      answer: QUESTION.options[1],
    });
  });

  it('une ligne DÉCLINÉE laisse passer la porte — le runner remplace le marqueur, il ne rejoue pas', async () => {
    // Le floor ne doit pas re-suspendre un appel déjà tranché : sinon un refus
    // rouvrirait une question à l'infini. L'exécution, elle, échoue clairement.
    const callId = 'call-ask-declined';
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'ask_user',
      toolInput: QUESTION,
      toolCallId: callId,
      kind: 'question',
      status: 'rejected',
      notes: 'None of these',
      resolvedAt: new Date(),
    });

    const result = await executeTool(
      askUserTool,
      QUESTION,
      makeCtx(callId),
      makeOpts([resumeBypassRule()]),
    );

    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') expect(result.error).toContain('question_unanswered');
  });

  it('une réponse HORS options est une incohérence, dite comme telle', async () => {
    const callId = 'call-ask-invalid';
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'ask_user',
      toolInput: QUESTION,
      toolCallId: callId,
      kind: 'question',
      status: 'approved',
      answer: 'Somewhere else entirely',
      resolvedAt: new Date(),
    });

    const result = await executeTool(
      askUserTool,
      QUESTION,
      makeCtx(callId),
      makeOpts([resumeBypassRule()]),
    );

    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') expect(result.error).toContain('question_answer_invalid');
  });
});

describe('ask_user — les entrées refusées', () => {
  const bad: Array<[string, unknown]> = [
    ['une seule option', { question: 'Which?', options: ['Only one'] }],
    ['sept options', { question: 'Which?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
    ['deux options identiques', { question: 'Which?', options: ['Same', 'Same'] }],
    ['deux options identiques après trim', { question: 'Which?', options: ['Same', ' Same '] }],
    ['une question vide', { question: '   ', options: ['a', 'b'] }],
    ['une option vide', { question: 'Which?', options: ['a', '  '] }],
  ];

  for (const [label, input] of bad) {
    it(`refuse ${label}, sans écrire de ligne d'approbation`, async () => {
      const callId = `call-bad-${label.replace(/\s+/g, '-')}`;
      const result = await executeTool(
        askUserTool,
        input,
        makeCtx(callId),
        makeOpts([resumeBypassRule()]),
      );
      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') expect(result.error).toContain('invalid_input');
      expect(await latestApproval(callId)).toBeUndefined();
    });
  }
});

describe('ask_user — sa place dans le produit', () => {
  it('est toujours disponible : un agent qui ne peut pas demander invente', () => {
    expect(ALWAYS_ON_TOOLS).toContain('ask_user');
  });

  it("déclare qu'il suspend le travail, et une carte `question`", () => {
    expect(askUserTool.asksUser).toBe(true);
    expect(askUserTool.card).toBe('question');
    expect(askUserTool.riskLevel).toBe('read');
  });
});
