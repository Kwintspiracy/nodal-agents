// thread-history-runner-notes.pg.test.ts — migration 0137 on rows that
// existed BEFORE it, against a real Postgres (Codex review of #576, pass 2).
//
// `stampFailedDelegations` has appended `[delegation stopped: … — no
// deliverable]` to `prose` results since 76761ae9, and failJob has written its
// generic explanation since 173b83a9. Neither recorded which lines were its
// own before 0137 added `runner_notes`. The replay keeps the last 8 turns of a
// conversation whatever their age, so those rows would still put the runner's
// line in the agent's mouth. 0137 fills `runner_notes` for them from the EXACT
// formats the runner writes, anchored at the end of `result`.
//
// How a pre-0137 row is made real here: every migration is applied, the rows
// are written with `runner_notes` NULL, then the migrator's own record of 0137
// is removed and `runMigrations` runs again. Drizzle applies an entry whose
// `when` is later than the last one it recorded, so 0137 runs for real, by
// the real migrator, on rows that were there before it.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  sql,
  eq,
  agentJobs,
  agents,
  conversations,
  entities,
  users,
} from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';
import { loadThreadHistory } from '../../job/thread-history.ts';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

const NOTICE = '[delegation stopped: assign_researcher — no deliverable]';
const GENERIC = '⚠️ The task could not be completed (turn_limit) and no explanation was provided.';
/** 0137's `when` in meta/_journal.json: what drizzle records as `created_at`. */
const WHEN_0137 = 1786002900000;

describe('migration 0137 fills runner_notes on rows written before it @cap:reprendre-conversation/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('a pre-0137 notice goes to the runner record on replay, the agent keeps its words', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [user] = await db.insert(users).values({ email: 'pre0137@ex.com' }).returning();
      const [entity] = await db
        .insert(entities)
        .values({ userId: user!.id, name: 'E', slug: 'e-pre0137' })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({ entityId: entity!.id, name: 'Root', slug: 'root-pre0137', personality: 'p' })
        .returning();
      const [conv] = await db
        .insert(conversations)
        .values({
          entityId: entity!.id,
          agentId: agent!.id,
          channel: 'whatsapp',
          chatId: 'pre0137',
          origin: 'user',
        })
        .returning();
      const base = {
        entityId: entity!.id,
        agentId: agent!.id,
        channel: 'whatsapp',
        chatId: 'pre0137',
        conversationId: conv!.id,
      };
      const [stamped] = await db
        .insert(agentJobs)
        .values({
          ...base,
          task: 'recherche la longueur de Planck',
          status: 'completed',
          resultKind: 'prose',
          result: `Le chercheur n’a rien rendu.\n\n${NOTICE}`,
          createdAt: new Date(Date.now() - 3 * 60_000),
        })
        .returning();
      const [generic] = await db
        .insert(agentJobs)
        .values({
          ...base,
          task: 'génère l’image',
          status: 'failed',
          result: GENERIC,
          messages: [
            { role: 'user', content: 'génère l’image' },
            { role: 'assistant', content: 'ComfyUI ne tourne pas.' },
          ],
          createdAt: new Date(Date.now() - 2 * 60_000),
        })
        .returning();
      // A line that merely LOOKS like a notice, in the middle of the agent's
      // text: the backfill is anchored, it does not touch it.
      const [lookalike] = await db
        .insert(agentJobs)
        .values({
          ...base,
          task: 'cite la ligne',
          status: 'completed',
          resultKind: 'prose',
          result: `La ligne ${NOTICE} veut dire que rien n’est revenu.`,
          createdAt: new Date(Date.now() - 60_000),
        })
        .returning();

      // Re-run 0137 on these rows, through the real migrator.
      await db.execute(
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${WHEN_0137}`,
      );
      await runMigrations(harness().url, { patchVectorAsText: true });

      const notes = async (id: string) =>
        (
          await db.select({ n: agentJobs.runnerNotes }).from(agentJobs).where(eq(agentJobs.id, id))
        )[0]?.n ?? null;
      expect(await notes(stamped!.id)).toEqual([NOTICE]);
      expect(await notes(generic!.id)).toEqual([GENERIC]);
      expect(await notes(lookalike!.id)).toBeNull();

      const history = await loadThreadHistory({
        db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
        conversationId: conv!.id,
        channel: 'whatsapp',
        excludeJobId: '00000000-0000-0000-0000-000000000000',
      });
      const spoken = history
        .filter((m) => m.role === 'assistant')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      expect(spoken).toEqual([
        'Le chercheur n’a rien rendu.',
        'ComfyUI ne tourne pas.',
        `La ligne ${NOTICE} veut dire que rien n’est revenu.`,
      ]);
      const recorded = history
        .map(
          (m) =>
            (m as { providerOptions?: { nodal?: { runnerRecord?: string[] } } }).providerOptions
              ?.nodal?.runnerRecord ?? [],
        )
        .flat();
      expect(recorded).toEqual([NOTICE, GENERIC]);
    } finally {
      await close();
    }
  });
});
