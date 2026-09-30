// runner-notes-db-safe.pg.test.ts — every write of `runner_notes` goes through
// the same byte normalization as `result`, against a real Postgres (Codex
// review of #576, pass 4).
//
// A checker's stderr tail, or an error code's detail, can carry a raw NUL or a
// lone UTF-16 surrogate. Postgres refuses both in `text` / `text[]`. `result`
// went through `toDbSafeString`; the same line written raw into
// `runner_notes` made the terminal UPDATE fail, so a run whose declared
// deliverable was not verified never reached `failed / deliverable_not_verified`.
//
// The test drives the real terminal doors on real rows:
//   - finalizeJobFailure with `replaceResult` + `runnerNotes` (the declared-
//     deliverable door of execute.ts), its line carrying NUL + a lone surrogate;
//   - failJob with nothing to say, its error code carrying the same bytes.
// Each must land, store the normalized line in `runner_notes`, and the replay
// of the thread must still take that line out of the agent's words.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  eq,
  agentJobs,
  agents,
  conversations,
  entities,
  users,
} from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';
import {
  finalizeJobFailure,
  deliverableNotVerifiedLine,
  DELIVERABLE_NOT_VERIFIED,
} from '../../job/finalize.ts';
import { failJob } from '../../job/state.ts';
import { toDbSafeString } from '../../job/transcript-text.ts';
import { loadThreadHistory } from '../../job/thread-history.ts';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

/** A NUL byte and a lone high surrogate: the two shapes Postgres refuses. */
const POISON = 'bad\u0000byte \uD83D half';

describe('runner_notes is written DB-safe by every producer @cap:reprendre-conversation/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('the declared-deliverable door and failJob land, with the normalized line in runner_notes', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [user] = await db.insert(users).values({ email: 'dbsafe@ex.com' }).returning();
      const [entity] = await db
        .insert(entities)
        .values({ userId: user!.id, name: 'E', slug: 'e-dbsafe' })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({ entityId: entity!.id, name: 'Root', slug: 'root-dbsafe', personality: 'p' })
        .returning();
      const [conv] = await db
        .insert(conversations)
        .values({
          entityId: entity!.id,
          agentId: agent!.id,
          channel: 'whatsapp',
          chatId: 'dbsafe',
          origin: 'user',
        })
        .returning();
      const base = {
        entityId: entity!.id,
        agentId: agent!.id,
        channel: 'whatsapp',
        chatId: 'dbsafe',
        conversationId: conv!.id,
        status: 'processing',
      };

      // 1. The declared-deliverable door (execute.ts → finalizeJobFailure).
      const line = deliverableNotVerifiedLine([
        { path: '/work/film.mp4', check: 'well-formed:mp4', detail: `stderr: ${POISON}` },
      ]);
      const [deliverable] = await db
        .insert(agentJobs)
        .values({
          ...base,
          task: 'rends le film',
          createdAt: new Date(Date.now() - 2 * 60_000),
        })
        .returning();
      const landed = await finalizeJobFailure(db as Parameters<typeof finalizeJobFailure>[0], {
        jobId: deliverable!.id,
        errorCode: DELIVERABLE_NOT_VERIFIED,
        userMessage: `Film livré.\n\n${line}`,
        replaceResult: true,
        runnerNotes: [line],
      });
      expect(landed).toBe(true);

      // 2. failJob with nothing to say: its generic explanation embeds the code.
      const [generic] = await db
        .insert(agentJobs)
        .values({
          ...base,
          task: 'lance la commande',
          messages: [
            { role: 'user', content: 'lance la commande' },
            { role: 'assistant', content: 'Je lance la commande.' },
          ],
          createdAt: new Date(Date.now() - 60_000),
        })
        .returning();
      expect(
        await failJob(db as Parameters<typeof failJob>[0], generic!.id, `bad_code: ${POISON}`),
      ).toBe(true);

      const row = async (id: string) =>
        (
          await db
            .select({
              status: agentJobs.status,
              error: agentJobs.error,
              result: agentJobs.result,
              notes: agentJobs.runnerNotes,
            })
            .from(agentJobs)
            .where(eq(agentJobs.id, id))
        )[0]!;
      const d = await row(deliverable!.id);
      expect(d.status).toBe('failed');
      expect(d.error).toBe(DELIVERABLE_NOT_VERIFIED);
      expect(d.notes).toEqual([toDbSafeString(line)]);
      expect(d.result!.endsWith(`\n\n${d.notes![0]}`)).toBe(true);
      const g = await row(generic!.id);
      expect(g.status).toBe('failed');
      expect(g.notes).toEqual([g.result]);
      expect(g.result).not.toContain('\u0000');

      // The replay still takes those lines out of the agent's words.
      const history = await loadThreadHistory({
        db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
        conversationId: conv!.id,
        channel: 'whatsapp',
        excludeJobId: '00000000-0000-0000-0000-000000000000',
        timezone: 'UTC',
      });
      const spoken = history
        .filter((m) => m.role === 'assistant')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      expect(spoken).toEqual(['Film livré.', 'Je lance la commande.']);
    } finally {
      await close();
    }
  });
});
