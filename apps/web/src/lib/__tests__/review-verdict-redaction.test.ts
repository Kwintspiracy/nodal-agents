// review-verdict-redaction.test.ts — le VERDICT d'une relecture est masqué
// avant d'atteindre un écran (#286), sur une vraie base, par les deux actions
// qui le chargent.
//
// Le trou : `lireVerdictsLivres` (`job-feed.ts`) et `readReviewVerdicts`
// (`review-verdicts.ts`) parsaient `tool_calls.tool_output` BRUT et rendaient
// le `summary`, le `file` et le `issue` de chaque constat tels quels. Ces
// textes sont écrits par l'agent relecteur : un relecteur qui recopie une
// commande qui échoue ou une ligne de configuration portant un jeton le posait
// en clair — sur le fil (`ConversationFeedView`) et dans la section de
// relecture d'un run (`ReviewSection`) — pendant que le MÊME jeton, dans le
// MÊME `tool_output`, était masqué partout ailleurs (#150, #165, #212).
//
// Ce que ce fichier prouve, et pourquoi de cette façon : les quatre endroits
// qui rendent ces mots lisent DEUX structures, celle de la page de run et
// celle du fil. L'assertion porte donc sur la charge ENTIÈRE que chaque action
// rend — le jeton n'y est nulle part — plutôt que sur quatre champs nommés :
// un champ ajouté demain serait sinon un trou silencieux.
//
// Mutation vérifiée : `redactReviewVerdict` retiré de l'un ou l'autre lecteur
// → le cas correspondant rougit sur le jeton retrouvé.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, conversations, toolCalls } from '@nodal-agents/db';
import { REDACTED_TEXT } from '@nodal-agents/shared';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

/** Une clé factice, de la forme réelle d'un jeton Anthropic. */
const CLE = 'sk-ant-api03-REVIEWREVIEWREVIEWREVIEWREVIEW99'; // secrets:allow (fixture : clé factice)

const ids = { racine: '', relecteur: '', fil: '' };

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [relecteurAgent] = await testDb
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Second Pair Of Eyes',
      slug: `relecteur-${Date.now()}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning({ id: agents.id });

  const [conv] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Relecture',
      origin: 'user',
      channel: 'telegram',
      chatId: 'verdict-286',
    })
    .returning({ id: conversations.id });
  ids.fil = conv!.id;

  const [racine] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'verdict-286',
      conversationId: ids.fil,
      task: 'Construis la petite application',
      status: 'completed',
      result: 'Fait.',
      messages: [],
      completedAt: new Date(),
    })
    .returning({ id: agentJobs.id });
  ids.racine = racine!.id;

  const [relecteur] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: relecteurAgent!.id,
      channel: 'internal',
      task: 'Relis la petite application',
      status: 'completed',
      parentJobId: ids.racine,
      result: 'Relecture faite.',
      messages: [],
      completedAt: new Date(),
    })
    .returning({ id: agentJobs.id });
  ids.relecteur = relecteur!.id;

  // La clé est posée AUX TROIS endroits que le relecteur écrit lui-même : le
  // résumé, le chemin d'un constat, et sa phrase.
  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: ids.relecteur,
    toolName: 'review_verdict',
    toolInput: {},
    toolOutput: JSON.stringify({
      ok: true,
      verdict: 'request_changes',
      summary: `La commande échoue : curl -H "authorization: Bearer ${CLE}" https://api`,
      findings: [
        {
          file: `config/${CLE}.env`,
          line: 12,
          issue: `La clé ${CLE} est écrite en dur.`,
          severity: 'blocker',
        },
      ],
      counts: { blocker: 1, major: 0, minor: 0 },
    }),
    turn: 1,
  });
});

describe('le verdict d’une relecture est masqué avant l’écran @cap:verifier-un-livrable/moteur', () => {
  it('la page d’un run ne porte la clé NULLE PART, et dit qu’elle masque', async () => {
    const { getSpaceConversationAction } = await import('../actions.ts');
    const r = await getSpaceConversationAction(ids.racine);
    expect(r.ok, 'le run se charge').toBe(true);
    if (!r.ok) return;

    // La charge ENTIÈRE, pas quatre champs nommés.
    expect(JSON.stringify(r.data)).not.toContain(CLE);

    const vue = r.data.verdicts[0];
    expect(vue, 'le run porte bien un verdict').toBeDefined();
    expect(vue?.summary).toContain(REDACTED_TEXT);
    // Le CONSTAT aussi : sa phrase et son chemin sont rendus par `ReviewSection`.
    expect(vue?.findings[0]?.issue).toContain(REDACTED_TEXT);
    expect(vue?.findings[0]?.file).toContain(REDACTED_TEXT);
    // Ce qui n'est pas un secret traverse intact : le verdict reste lisible.
    expect(vue?.verdict).toBe('request_changes');
    expect(vue?.counts).toEqual({ blocker: 1, major: 0, minor: 0 });
    expect(vue?.findings[0]?.severity).toBe('blocker');
    expect(vue?.findings[0]?.line).toBe(12);

    // L'AUTRE lecteur, sur la même page : `lireVerdictsLivres` pose le verdict
    // enregistré sur le bloc de délégation, que `ConversationFeedView` rend.
    const enfant = r.data.feed.items.find((i) => i.kind === 'child');
    expect(enfant, 'le fil du run porte bien la délégation').toBeDefined();
    if (enfant?.kind !== 'child') return;
    expect(enfant.job.reviewVerdict?.summary).toContain(REDACTED_TEXT);
    expect(enfant.job.reviewVerdict?.findings[0]?.issue).toContain(REDACTED_TEXT);
    expect(enfant.job.reviewVerdict?.findings[0]?.file).toContain(REDACTED_TEXT);
    expect(enfant.job.reviewVerdict?.verdict).toBe('request_changes');
    expect(enfant.job.reviewVerdict?.counts).toEqual({ blocker: 1, major: 0, minor: 0 });
  });

  it('le FIL D’UNE CONVERSATION ne porte la clé nulle part non plus', async () => {
    // L'autre porte d'entrée sur les mêmes lignes : la conversation entière.
    const { getConversationThreadAction } = await import('../conversation-actions.ts');
    const r = await getConversationThreadAction(ids.fil);
    expect(r.ok, 'le fil s’assemble').toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.data)).not.toContain(CLE);
    // Et le verdict n'a pas disparu au passage : il est là, masqué.
    expect(JSON.stringify(r.data)).toContain(REDACTED_TEXT);
    expect(JSON.stringify(r.data)).toContain('request_changes');
  });

  it('la ligne STOCKÉE reste intacte — l’orchestration la relit pour décider', async () => {
    const [ligne] = await testDb.select().from(toolCalls);
    expect(ligne?.toolOutput).toContain(CLE);
  });
});
