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
// are written with `runner_notes` NULL, then the migrator's records of 0137
// AND of every later migration are removed and `runMigrations` runs again.
// Drizzle applies the entries whose `when` is later than the LAST one it
// recorded: removing 0137's record alone re-ran it only while it was the last
// migration (0138 added a later one). So 0137 runs for real, by the real
// migrator, on rows that were there before it; the later ones, idempotent
// (`IF NOT EXISTS`), run again with it.

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
import { deliverableNotVerifiedLine, DELIVERABLE_NOT_VERIFIED } from '../../job/finalize.ts';
import { failJob } from '../../job/state.ts';

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
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= ${WHEN_0137}`,
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

  // Codex review of #576, pass 3: a producer can put MULTI-LINE text inside
  // its line. `deliverableNotVerifiedLine` embeds a checker's stderr tail as
  // is, and failJob's generic explanation embeds its error code, which can
  // carry a multi-line detail (`shell_policy_invalid: ${detail}`). Both rows
  // are written by the REAL producers, then taken back to their pre-0137
  // state (`runner_notes` NULL) before 0137 runs again.
  it('multi-line producer output is caught whole: a stderr tail, an error code with a detail', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [user] = await db.insert(users).values({ email: 'multi0137@ex.com' }).returning();
      const [entity] = await db
        .insert(entities)
        .values({ userId: user!.id, name: 'E2', slug: 'e-multi0137' })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({ entityId: entity!.id, name: 'Root', slug: 'root-multi0137', personality: 'p' })
        .returning();
      const [conv] = await db
        .insert(conversations)
        .values({
          entityId: entity!.id,
          agentId: agent!.id,
          channel: 'whatsapp',
          chatId: 'multi0137',
          origin: 'user',
        })
        .returning();
      const base = {
        entityId: entity!.id,
        agentId: agent!.id,
        channel: 'whatsapp',
        chatId: 'multi0137',
        conversationId: conv!.id,
      };

      // 1. The declared-deliverable line with a multi-line stderr tail, as
      //    finalize.ts writes it: the run's last text, a blank line, the line.
      const line = deliverableNotVerifiedLine([
        {
          path: '/work/film.mp4',
          check: 'well-formed:mp4',
          detail: 'moov atom not found\n/work/film.mp4: Invalid data found when processing input',
        },
        { path: '/work/cover.png', check: 'exists', detail: '/work/cover.png not found' },
      ]);
      expect(line).toContain('\n');
      // The run's text QUOTES an earlier line of the same shape, at the start
      // of a paragraph: the runner's line is the LAST one, and only it goes.
      const said =
        'La preuve d’hier disait :\n\n[stopped: declared deliverable not verified — /old.mp4: exists]\n\nFilm livré.';
      const [deliverable] = await db
        .insert(agentJobs)
        .values({
          ...base,
          task: 'rends le film',
          status: 'failed',
          error: DELIVERABLE_NOT_VERIFIED,
          result: `${said}\n\n${line}`,
          createdAt: new Date(Date.now() - 2 * 60_000),
        })
        .returning();

      // 2. failJob's generic explanation, written by failJob itself, with an
      //    error code carrying a multi-line detail.
      const [generic] = await db
        .insert(agentJobs)
        .values({
          ...base,
          task: 'lance la commande',
          status: 'processing',
          messages: [
            { role: 'user', content: 'lance la commande' },
            { role: 'assistant', content: 'Je lance la commande.' },
          ],
          createdAt: new Date(Date.now() - 60_000),
        })
        .returning();
      await failJob(
        db as Parameters<typeof failJob>[0],
        generic!.id,
        'shell_policy_invalid: unknown kind "x"\nat entry 2 (policy.json)',
      );
      // Back to what a row looked like before 0137 recorded runner lines.
      await db.update(agentJobs).set({ runnerNotes: null }).where(eq(agentJobs.id, generic!.id));
      const [genericRow] = await db
        .select({ result: agentJobs.result })
        .from(agentJobs)
        .where(eq(agentJobs.id, generic!.id));
      expect(genericRow?.result).toContain('\n');

      await db.execute(
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= ${WHEN_0137}`,
      );
      await runMigrations(harness().url, { patchVectorAsText: true });

      const notes = async (id: string) =>
        (
          await db.select({ n: agentJobs.runnerNotes }).from(agentJobs).where(eq(agentJobs.id, id))
        )[0]?.n ?? null;
      expect(await notes(deliverable!.id)).toEqual([line]);
      expect(await notes(generic!.id)).toEqual([genericRow!.result]);

      const history = await loadThreadHistory({
        db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
        conversationId: conv!.id,
        channel: 'whatsapp',
        excludeJobId: '00000000-0000-0000-0000-000000000000',
      });
      const spoken = history
        .filter((m) => m.role === 'assistant')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      expect(spoken).toEqual([said, 'Je lance la commande.']);
      const recorded = history
        .map(
          (m) =>
            (m as { providerOptions?: { nodal?: { runnerRecord?: string[] } } }).providerOptions
              ?.nodal?.runnerRecord ?? [],
        )
        .flat();
      expect(recorded).toEqual([line, genericRow!.result]);
    } finally {
      await close();
    }
  });
});
