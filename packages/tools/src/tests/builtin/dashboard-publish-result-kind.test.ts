// dashboard-publish-result-kind.test.ts — `dashboard_publish` écrit le texte
// ET sa provenance, dans la même écriture (#154).
//
// @cap:suivre-execution/moteur
//
// Cet outil est le SEUL de `packages/tools` à écrire `agent_jobs.result` : il
// pose donc, avec le texte, la marque qui dit d'où ce texte vient. Sans elle,
// le fil d'une conversation retombait sur son ancienne heuristique — le
// premier caractère du résultat — et refusait comme « machine » une revue que
// l'agent avait publiée sous forme de tableau JSON lisible.
//
// L'assertion porte sur la LIGNE relue, jamais sur l'appel.
//
// Mutation vérifiée : `resultKind: 'prose'` retiré du `.set()` de l'outil
// ⇒ le second test rougit (« la publication est restée sans provenance »).

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, agentJobs } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { dashboardPublishTool } from '../../builtin/dashboard-publish';
import type { ToolContext } from '../../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

function makeCtx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

async function rowOf(jobId: string): Promise<{ result: string | null; kind: string | null }> {
  const [r] = await db
    .select({ result: agentJobs.result, resultKind: agentJobs.resultKind })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return { result: r?.result ?? null, kind: r?.resultKind ?? null };
}

describe('dashboard_publish — le texte et sa provenance @cap:suivre-execution/moteur', () => {
  it('publie le texte de l’agent dans le résultat du job', async () => {
    await dashboardPublishTool.execute({ text: '# Revue\n\nTrois constats.' }, makeCtx());
    expect((await rowOf(seed.jobId)).result).toBe('# Revue\n\nTrois constats.');
  });

  it('marque cette publication comme la PROSE de l’agent, quelle que soit sa forme', async () => {
    // Le trou de #154, pris à la source : un tableau JSON publié par l'agent
    // reste sa réponse. La marque le dit ; le premier caractère ne le dira
    // jamais.
    await dashboardPublishTool.execute({ text: '["3 constats, aucun bloquant"]' }, makeCtx());

    const row = await rowOf(seed.jobId);
    expect(row.result).toBe('["3 constats, aucun bloquant"]');
    expect(row.kind, 'la publication est restée sans provenance').toBe('prose');
  });
});
