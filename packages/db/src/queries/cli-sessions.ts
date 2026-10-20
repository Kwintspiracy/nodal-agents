// queries/cli-sessions.ts — LA règle de reprise d'une session de CLI (#824).
//
// Une CLI (Claude Code, Codex) garde elle-même la transcription de sa session
// et la rejoue à chaque reprise : le runner ne la voit jamais, et la frontière
// des handles (`cliTurnForModel`, runner) ne peut pas la réécrire. Une session
// ouverte AVANT cette frontière peut donc porter des identifiants de
// conversation bruts (un numéro de téléphone) que la CLI renverrait à son
// fournisseur à chaque tour.
//
// La règle : une session n'est reprise que si elle porte la marque
// `opened_with_handles`, posée par toute session écrite depuis la frontière.
// Une session sans marque n'est JAMAIS reprise — ni « reprise en espérant » :
// le tour suivant repart d'une session neuve, une fois, et celle-ci est
// marquée. Une seule règle pour les trois lieux qui reprennent une session :
// le chemin job et le chemin chat du runtime CLI (run-job.ts, run-chat.ts) et
// l'outil `code_task` (packages/tools), pour les deux CLI.

import { and, eq, sql } from 'drizzle-orm';
import { cliSessions } from '../schema/cli-runs.ts';
import type { AnyDrizzleDb } from '../client.ts';

/**
 * L'identifiant de session à reprendre pour (agent, conversation, CLI), ou
 * null : aucune session, une session d'une autre CLI, ou une session ouverte
 * avant la frontière (sans marque) — celle-là repart à neuf.
 */
export async function findResumableCliSession(
  db: AnyDrizzleDb,
  key: { agentId: string; conversationKey: string; provider: string },
): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: cliSessions.sessionId })
    .from(cliSessions)
    .where(
      and(
        eq(cliSessions.agentId, key.agentId),
        eq(cliSessions.conversationKey, key.conversationKey),
        // Une session appartient à la CLI qui l'a créée : reprendre une
        // session claude par codex (ou l'inverse) échoue à la CLI.
        eq(cliSessions.provider, key.provider),
        eq(cliSessions.openedWithHandles, true),
      ),
    )
    .limit(1);
  return row?.sessionId ?? null;
}

/**
 * Retient la session de ce tour, MARQUÉE : tout ce que la CLI y a lu est
 * passé par la frontière. Remplace la ligne de (agent, conversation) — le
 * fournisseur est reposé avec l'identifiant, sinon après une bascule de
 * runtime la ligne se contredirait.
 */
export async function rememberCliSession(
  db: AnyDrizzleDb,
  session: {
    entityId: string | null;
    agentId: string;
    conversationKey: string;
    provider: string;
    sessionId: string;
  },
): Promise<void> {
  await db
    .insert(cliSessions)
    .values({ ...session, openedWithHandles: true })
    .onConflictDoUpdate({
      target: [cliSessions.agentId, cliSessions.conversationKey],
      set: {
        sessionId: session.sessionId,
        provider: session.provider,
        openedWithHandles: true,
        updatedAt: sql`now()`,
      },
    });
}
