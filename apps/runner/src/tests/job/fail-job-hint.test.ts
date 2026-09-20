// fail-job-hint.test.ts — LE GESTE QU'UN ÉCHEC APPELLE ARRIVE SUR LA LIGNE (#193).
//
// Ce que ce fichier prouve, et que les tests d'écran ne prouvent pas : le mot
// que le runner décide est ÉCRIT dans `agent_jobs.failure_hint`. Avant #193 il
// ne l'était nulle part — il voyageait en mémoire jusqu'au parent, et l'écran
// le re-déduisait du code d'erreur. Les assertions portent donc sur la LIGNE
// relue, jamais sur un appel.
//
// Mutation vérifiée : `failureHint: hint ?? null` retiré de l'UPDATE de
// `failJob` → « le geste décidé est écrit sur la ligne » rougit (la colonne
// revient `null`).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs } from '@nodal-agents/db';
import { failJob } from '../../job/state.ts';

let db: TestDb;
let seed: { entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const semence = await seedMinimal(db);
  seed = { entityId: semence.entityId, agentId: semence.agentId };
});

/** Une ligne de job neuve, en cours — chaque cas a la sienne. */
async function jobEnCours(): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'compare les deux rapports',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('la ligne de job n’a pas été créée');
  return row.id;
}

/** La ligne, relue en base : le seul fait qui compte ici. */
async function ligne(jobId: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      error: agentJobs.error,
      failureHint: agentJobs.failureHint,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('la ligne de job a disparu');
  return row;
}

describe('failJob écrit le geste décidé @cap:suivre-execution/moteur', () => {
  it('le geste décidé est écrit sur la ligne, à côté du code d’erreur', async () => {
    const jobId = await jobEnCours();
    const code = 'provider_rejected_request:openrouter/google/gemini-3.7-flash (http 400, turn 3)';

    const atterri = await failJob(
      db as Parameters<typeof failJob>[0],
      jobId,
      code,
      undefined,
      undefined,
      undefined,
      'switch_model',
    );

    expect(atterri).toBe(true);
    const apres = await ligne(jobId);
    expect(apres.status).toBe('failed');
    // Les DEUX faits, et pas l'un pour l'autre : le code sert au diagnostic, le
    // geste sert à l'écran. C'est justement parce qu'ils étaient confondus que
    // la correspondance vivait à deux endroits (#193).
    expect(apres.error).toBe(code);
    expect(apres.failureHint).toBe('switch_model');
  });

  it('un échec qui n’appelle aucun geste laisse la colonne vide', async () => {
    const jobId = await jobEnCours();

    await failJob(db as Parameters<typeof failJob>[0], jobId, 'delivery_spam_guard');

    const apres = await ligne(jobId);
    expect(apres.error).toBe('delivery_spam_guard');
    // NULL, jamais une chaîne vide : l'écran distingue « rien à dire » de
    // « un geste dont le nom est vide », qui n'existe pas.
    expect(apres.failureHint).toBeNull();
  });

  it('la course perdue n’écrit aucun geste sur une ligne déjà terminale', async () => {
    const jobId = await jobEnCours();
    // Le premier écrivain gagne, sans geste.
    await failJob(db as Parameters<typeof failJob>[0], jobId, 'runner_restarted');

    // Le second arrive trop tard, geste en main : la ligne ne bouge pas.
    const atterri = await failJob(
      db as Parameters<typeof failJob>[0],
      jobId,
      'provider_rejected_request:openrouter/x (http 400, turn 1)',
      undefined,
      undefined,
      undefined,
      'switch_model',
    );

    expect(atterri).toBe(false);
    const apres = await ligne(jobId);
    expect(apres.error).toBe('runner_restarted');
    expect(apres.failureHint).toBeNull();
  });
});
