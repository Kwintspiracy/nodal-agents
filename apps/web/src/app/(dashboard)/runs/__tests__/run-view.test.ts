// run-view.test.ts — ce que la page d'un run LIT dans les données du chargeur.
//
// Ces fonctions décident ce que l'écran affiche : les sept chiffres de
// l'en-tête, la provenance, la réponse sortie du fil, le résumé de l'activité.
// Chaque cas prouve une VALEUR rendue, jamais un appel : un chiffre absent doit
// donner « — » et pas un 0, une réponse doit sortir du bon endroit.

import { describe, it, expect } from 'vitest';
import type { SpaceConversationView } from '@/lib/actions.ts';
import type { ConversationFeed, FeedItem, Step } from '@/lib/conversation-feed.ts';
import {
  UNKNOWN,
  activityLabel,
  activitySummary,
  dropTaskRequest,
  liftDelivered,
  liftReply,
  runFilesChanged,
  runModel,
  runOrigin,
  runStats,
  runStatus,
} from '../run-view.ts';

const totals: ConversationFeed['totals'] = {
  turns: 1,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: null,
  llmDurationMs: 0,
  models: [],
};

const turn = (over: Partial<Extract<FeedItem, { kind: 'turn' }>> = {}): FeedItem => ({
  kind: 'turn',
  index: 1,
  turn: 1,
  turnSource: 'audit',
  agent: { name: 'Nestor', slug: 'nestor', avatarUrl: null },
  model: 'z-ai/glm-5.3',
  blocks: [{ kind: 'prose', text: 'Digest posted.' }],
  usage: null,
  at: null,
  ...over,
});

const filesStep = (
  files: Array<{ path: string; action: 'created' | 'modified' | 'written' | 'listed' }>,
): Step => ({
  kind: 'tool',
  toolName: 'file_write',
  toolCallId: 'c1',
  jobId: 'job-1',
  card: 'files',
  presented: { card: 'files', files, total: files.length, truncated: false },
  input: {},
  outputText: null,
  outcome: 'success',
  durationMs: 10,
  lineCounts: {},
  question: null,
});

function view(over: {
  job?: Partial<SpaceConversationView['job']>;
  items?: FeedItem[];
  cost?: Partial<SpaceConversationView['cost']['totals']>;
}): SpaceConversationView {
  return {
    job: {
      id: 'job-1',
      task: 'Weekly digest of the open GitHub issues',
      channel: 'cron',
      status: 'completed',
      agentName: 'Nestor',
      agentSlug: 'nestor',
      agentAvatarUrl: null,
      createdAt: new Date('2026-09-18T09:00:00Z'),
      completedAt: new Date('2026-09-18T09:00:41Z'),
      conversationId: null,
      parentJobId: null,
      scheduleName: 'every Monday 09:00',
      scheduleId: 'schedule-1',
      resultKind: null,
      ...over.job,
    },
    feed: { items: over.items ?? [turn()], totals },
    verdicts: [],
    verification: { sequences: [], skippedSurfaces: [], unconfigured: [], deliverables: [] },
    cost: {
      byAgent: [],
      // #54 — ce run n'a pas de reprise sur cache expiré : la barre n'en dit rien.
      cacheLost: { resumes: 0, tokens: 0, costUsd: null, unpricedResumes: 0 },
      totals: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
        unpricedCalls: 0,
        llmDurationMs: 0,
        durationMs: 0,
        humanWaitMs: 0,
        proofMs: 0,
        ...over.cost,
      },
    },
    deliveries: [],
  };
}

const valueOf = (data: SpaceConversationView, label: string): string =>
  runStats(data).find((s) => s.label === label)?.value ?? 'ABSENT';

describe('run-view — les sept chiffres de l’en-tête @cap:suivre-execution/ecran', () => {
  it('les sept cases sont là, dans l’ordre du détail Code', () => {
    expect(runStats(view({})).map((s) => s.label)).toEqual([
      'Cost',
      'Duration',
      'Input tokens',
      'Output tokens',
      'Cache reads',
      'Files changed',
      'Activity',
    ]);
  });

  it('« — » veut dire ABSENT : un coût sans appel tarifé, une durée sans début', () => {
    const data = view({ job: { createdAt: null } });
    // Aucun appel tarifé : un coût inconnu n'est pas un coût nul.
    expect(valueOf(data, 'Cost')).toBe(UNKNOWN);
    // Pas de date de début : il n'y a rien à mesurer.
    expect(valueOf(data, 'Duration')).toBe(UNKNOWN);
    // Aucune carte `files` dans le fil : on ne sait pas ce qui a été écrit.
    expect(valueOf(data, 'Files changed')).toBe(UNKNOWN);
  });

  it('un vrai ZÉRO s’écrit 0 — un run qui n’a appelé aucun modèle n’est pas une donnée manquante', () => {
    // Reviewer C, passe 1 : « 0 jeton » et « jeton inconnu » s'affichaient
    // pareil, et le second est bien plus grave que le premier.
    const data = view({});
    expect(valueOf(data, 'Input tokens')).toBe('0');
    expect(valueOf(data, 'Output tokens')).toBe('0');
    expect(valueOf(data, 'Cache reads')).toBe('0');
    // Un travail qui vient de commencer a une durée de zéro, pas d'inconnue.
    expect(valueOf(data, 'Duration')).toBe('0 ms');
  });

  it('les valeurs connues sont formatées, coût compris', () => {
    const data = view({
      cost: { costUsd: 0.0423, durationMs: 41_200, inputTokens: 12410, cachedTokens: 8900 },
    });
    expect(valueOf(data, 'Cost')).toBe('$0.04');
    expect(valueOf(data, 'Duration')).toBe('41.2 s');
    expect(valueOf(data, 'Input tokens')).toBe('12,410');
    expect(valueOf(data, 'Cache reads')).toBe('8,900');
  });

  it('un coût de zéro dollar EST un coût — il ne devient pas « — »', () => {
    expect(valueOf(view({ cost: { costUsd: 0 } }), 'Cost')).toBe('$0.00');
  });

  it('les fichiers se comptent sur les cartes du fil, sans les fichiers seulement lus', () => {
    const items = [
      turn({
        blocks: [
          {
            kind: 'steps',
            steps: [
              filesStep([
                { path: 'a.md', action: 'written' },
                { path: 'a.md', action: 'modified' },
                { path: 'b.md', action: 'listed' },
              ]),
            ],
          },
        ],
      }),
    ];
    expect(runFilesChanged(items)).toBe(1);
    expect(valueOf(view({ items }), 'Files changed')).toBe('1');
  });
});

describe('run-view — d’où vient le run @cap:suivre-execution/ecran', () => {
  it('une automatisation dit sa routine', () => {
    expect(
      runOrigin({ channel: 'cron', scheduleName: 'every Monday 09:00', parentJobId: null }),
    ).toBe('scheduled · every Monday 09:00');
  });

  it('une automatisation sans nom de routine dit juste « scheduled »', () => {
    expect(runOrigin({ channel: 'cron', scheduleName: null, parentJobId: null })).toBe('scheduled');
  });

  it('un run délégué le dit — le nom de l’agent parent n’est pas dans ces données', () => {
    expect(runOrigin({ channel: 'internal', scheduleName: null, parentJobId: 'job-0' })).toBe(
      'delegated',
    );
  });

  it('sinon, le canal, avec les mots du fil', () => {
    expect(runOrigin({ channel: 'telegram', scheduleName: null, parentJobId: null })).toBe(
      'via Telegram',
    );
    expect(runOrigin({ channel: 'dashboard', scheduleName: null, parentJobId: null })).toBe(
      'from the dashboard',
    );
  });

  it('le modèle vient du premier tour qui en nomme un', () => {
    expect(runModel({ items: [turn()], totals })).toBe('z-ai/glm-5.3');
    expect(runModel({ items: [turn({ model: null })], totals })).toBeNull();
    expect(
      runModel({ items: [turn({ model: null })], totals: { ...totals, models: ['qwen3.8-max'] } }),
    ).toBe('qwen3.8-max');
  });

  it('l’état porte le mot du statut, et un statut inconnu s’écrit tel quel', () => {
    expect(runStatus('completed')).toEqual({ variant: 'done', label: 'Done' });
    expect(runStatus('failed')).toEqual({ variant: 'warn', label: 'Failed' });
    expect(runStatus('processing')).toEqual({ variant: 'run', label: 'Running' });
    expect(runStatus('teleported')).toEqual({ variant: 'idle', label: 'teleported' });
  });
});

describe('run-view — la demande retirée de la chronologie @cap:suivre-execution/ecran', () => {
  const origin = { channel: 'cron', scheduleName: 'lundi 09:00', chatId: null };
  const task = 'Écris le digest de la semaine';

  it('la demande qui répète la tâche quitte le fil — elle titre déjà la page', () => {
    const items: FeedItem[] = [{ kind: 'request', text: task, origin, at: null }, turn()];
    const out = dropTaskRequest(items, task);
    expect(out.some((i) => i.kind === 'request')).toBe(false);
    expect(out).toHaveLength(1);
  });

  it('les espaces et les retours à la ligne ne font pas une autre demande', () => {
    const items: FeedItem[] = [
      { kind: 'request', text: `  Écris le digest\n  de la semaine `, origin, at: null },
      turn(),
    ];
    expect(dropTaskRequest(items, 'Écris le digest de la semaine')).toHaveLength(1);
  });

  it('une demande qui dit AUTRE chose reste : la carte de tête ne la porte pas', () => {
    const items: FeedItem[] = [
      { kind: 'request', text: 'Et le mois dernier ?', origin, at: null },
      turn(),
    ];
    expect(dropTaskRequest(items, task)).toHaveLength(2);
  });

  it('un fil sans demande n’est pas touché', () => {
    const items: FeedItem[] = [turn(), turn({ index: 2 })];
    expect(dropTaskRequest(items, task)).toEqual(items);
  });
});

describe('run-view — la réponse sortie du fil @cap:suivre-execution/ecran', () => {
  const done = { completedAt: new Date('2026-09-18T09:00:41Z') };
  /** Le rapport d'un relecteur, tel que le bloc Review le porte déjà. */
  const RAPPORT = '# Rapport\n\nDeux majeurs fermés, un mineur reste.';

  it('un item `answer` sort du fil, et le fil ne le montre plus', () => {
    const items: FeedItem[] = [turn(), { kind: 'answer', text: 'Digest posted.' }];
    const lifted = liftReply(items, done);
    expect(lifted.reply).toBe('Digest posted.');
    expect(lifted.items.some((i) => i.kind === 'answer')).toBe(false);
    expect(lifted.items).toHaveLength(1);
  });

  it('sans item `answer`, c’est la DERNIÈRE prose du DERNIER tour qui sort', () => {
    const items: FeedItem[] = [
      turn({ index: 1, blocks: [{ kind: 'prose', text: 'Je commence.' }] }),
      turn({ index: 2, blocks: [{ kind: 'prose', text: 'Fourteen issues this week.' }] }),
    ];
    const lifted = liftReply(items, done);
    expect(lifted.reply).toBe('Fourteen issues this week.');
    // Le tour vidé de sa prose et sans appel de modèle disparaît ; le premier,
    // lui, garde la sienne : une prose intermédiaire n'est pas une réponse.
    expect(lifted.items).toHaveLength(1);
    expect(lifted.items[0]).toMatchObject({ kind: 'turn', index: 1 });
  });

  it('un `result` qui se lit comme une réponse sort à la place de la prose', () => {
    const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: 'Je publie le digest.' }] })];
    const lifted = liftReply(items, { ...done, result: 'Digest posted, 14 issues.' });
    expect(lifted.reply).toBe('Digest posted, 14 issues.');
    // La prose reste dans la chronologie : elle a bien eu lieu.
    expect(lifted.items).toHaveLength(1);
    expect(lifted.items[0]).toMatchObject({ kind: 'turn' });
  });

  it('SANS marque, un `result` en JSON est pour une machine : c’est la prose qui sort', () => {
    // Le repli de #154 : sans `result_kind`, l'heuristique du premier
    // caractère reprend la main, pour les runs d'avant la colonne.
    const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: 'Fourteen issues.' }] })];
    const lifted = liftReply(items, { ...done, result: '{"issues":14}' });
    expect(lifted.reply).toBe('Fourteen issues.');
  });

  it('marqué prose, un `result` en JSON lisible sort quand même (#154)', () => {
    const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: 'Je publie.' }] })];
    const lifted = liftReply(items, { ...done, result: '["14 issues"]' }, false, 'prose');
    expect(lifted.reply).toBe('["14 issues"]');
  });

  it('un run RELU n’a pas de réponse en haut : le bloc Review est sa réponse', () => {
    // Quentin, 18/09, après mesure : comparer la réponse au rapport ne marche
    // pas — un modèle qui recopie « tel quel » ne recopie pas octet pour octet
    // (divergence au caractère 341 sur 5 835, blancs normalisés). La règle est
    // un FAIT : un verdict enregistré, donc pas de réponse en haut, quel que
    // soit le texte.
    const recopie = `Rapport de la relecture, tel quel :\n\n---\n\n${RAPPORT}`;
    const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: recopie }] })];
    expect(liftReply(items, done, true).reply).toBeNull();
    // Même une réponse qui ne ressemble en rien au rapport : c'est la relecture
    // qui est la réponse de ce run.
    const autre: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: 'Je livre.' }] })];
    expect(liftReply(autre, done, true).reply).toBeNull();
  });

  it('un run relu GARDE tout dans sa chronologie : la prose reste dans son tour', () => {
    // Sortir la prose pour ne pas l'afficher l'aurait fait disparaître des deux
    // endroits.
    const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: 'Je livre.' }] })];
    const lifted = liftReply(items, done, true);
    expect(lifted.items).toHaveLength(1);
    const reste = lifted.items[0];
    expect(reste?.kind === 'turn' && reste.blocks).toEqual([{ kind: 'prose', text: 'Je livre.' }]);
  });

  it('sans verdict, la réponse sort comme avant', () => {
    const propre = 'Second Reader a fermé les deux majeurs. Je livre.';
    const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: propre }] })];
    expect(liftReply(items, done, false).reply).toBe(propre);
    // Et le défaut du paramètre est « pas relu » : un appelant qui l'ignore
    // obtient le comportement d'avant.
    expect(liftReply(items, done).reply).toBe(propre);
  });

  it('un run relu qui a fini SANS un mot : son item `answer` quitte quand même le fil', () => {
    const items: FeedItem[] = [turn(), { kind: 'answer', text: 'Digest posted.' }];
    const lifted = liftReply(items, done, true);
    expect(lifted.reply).toBeNull();
    expect(lifted.items.some((i) => i.kind === 'answer')).toBe(false);
  });

  it('rien ne sort tant que le run court : sa dernière phrase est une étape', () => {
    expect(liftReply([turn()], { completedAt: null }).reply).toBeNull();
  });

  // #210 — ce que la marque change pour un run relu. La règle de 0.8.11 était
  // large : TOUT verdict enregistré cachait la réponse, y compris celle d'un
  // run de code qui avait fait son propre travail. La marque tranche.
  describe('#210 — un run relu, sa réponse et son bloc Review @cap:suivre-execution/ecran', () => {
    const RELAI = '## reviewer-c\nDeux majeurs fermés, un mineur reste.';

    it('marqué relay, la réponse reste cachée : le bloc Review la porte déjà', () => {
      // Le cas de Quentin, 18/09 : l'orchestrateur n'a rien écrit de sa main,
      // son résultat EST le rapport de son délégué. L'afficher en haut le
      // ferait lire deux fois.
      const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: 'Je délègue.' }] })];
      const lifted = liftReply(items, { ...done, result: RELAI }, true, 'relay');
      expect(lifted.reply).toBeNull();
      // Et la chronologie garde tout : la prose reste DANS son tour.
      expect(lifted.items).toHaveLength(1);
      const reste = lifted.items[0];
      expect(reste?.kind === 'turn' && reste.blocks).toEqual([
        { kind: 'prose', text: 'Je délègue.' },
      ]);
    });

    it('marqué prose, un run de code relu GARDE sa phrase finale en haut', () => {
      // CE QUE #210 DEMANDAIT DE RÉCUPÉRER. Le run a fait le travail, un
      // délégué l'a relu, et la dernière phrase de l'agent est la sienne —
      // pas le rapport. Elle se lit sous l'en-tête, au-dessus de Review.
      const sienne = 'J’ai corrigé les deux majeurs et ajouté un test.';
      const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: sienne }] })];
      const lifted = liftReply(items, { ...done, result: sienne }, true, 'prose');
      expect(lifted.reply).toBe(sienne);
    });

    it('marqué relay, la réponse est cachée MÊME sans verdict enregistré', () => {
      // La marque suffit : elle dit que ce texte n'est pas de l'agent. Elle ne
      // dépend pas d'un verdict, qui peut manquer sur un run qui a seulement
      // délégué.
      const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: 'Je délègue.' }] })];
      expect(liftReply(items, { ...done, result: RELAI }, false, 'relay').reply).toBeNull();
    });

    it('marqué relay, un item `answer` quitte le fil sans être affiché', () => {
      const items: FeedItem[] = [turn(), { kind: 'answer', text: RELAI }];
      const lifted = liftReply(items, done, true, 'relay');
      expect(lifted.reply).toBeNull();
      expect(lifted.items.some((i) => i.kind === 'answer')).toBe(false);
    });

    it('SANS marque, la règle de 0.8.11 s’applique encore : un verdict cache la réponse', () => {
      // Le repli, DIT et tenu : un run fini avant la colonne n'a pas de
      // provenance, et on ne lui en invente pas une.
      const items: FeedItem[] = [turn({ blocks: [{ kind: 'prose', text: 'Je livre.' }] })];
      expect(liftReply(items, done, true, null).reply).toBeNull();
    });
  });

  it('rien ne sort d’un run qui a ÉCHOUÉ : la carte d’échec dit ce qui s’est passé', () => {
    const items: FeedItem[] = [turn(), { kind: 'failure', text: 'boom', hint: null }];
    const lifted = liftReply(items, done);
    expect(lifted.reply).toBeNull();
    expect(lifted.items.some((i) => i.kind === 'failure')).toBe(true);
  });

  it('le récapitulatif de livraison sort lui aussi, quand le fil en porte un', () => {
    const produced: FeedItem = {
      kind: 'produced',
      jobId: 'job-1',
      status: null,
      verdict: { isWork: true, items: [], uncertain: 0, more: 0, unclassified: 0 },
      project: null,
      summary: {
        files: 0,
        filePaths: [],
        lines: null,
        tests: null,
        durationMs: 41_000,
        costUsd: 0.04,
        reviews: [],
        checks: [],
        verdict: null,
        review: null,
        changesRequested: false,
        commands: [],
        produced: true,
        ended: null,
        live: false,
      },
    };
    const lifted = liftDelivered([turn(), produced]);
    expect(lifted.delivered).toBe(produced);
    expect(lifted.items.some((i) => i.kind === 'produced')).toBe(false);
    // Aucun récapitulatif dans le fil ⇒ rien à sortir, et le fil est intact.
    expect(liftDelivered([turn()]).delivered).toBeNull();
  });
});

describe('run-view — le résumé de l’activité @cap:suivre-execution/ecran', () => {
  it('compte les blocs, les agents DISTINCTS, et la durée du run', () => {
    const items: FeedItem[] = [
      turn(),
      turn({ index: 2 }),
      turn({ index: 3, agent: { name: 'Second Reader', slug: 'second-reader', avatarUrl: null } }),
    ];
    const summary = activitySummary(items, {
      createdAt: new Date('2026-09-18T09:00:00Z'),
      completedAt: new Date('2026-09-18T09:00:41Z'),
    });
    expect(summary).toEqual({ steps: 3, agents: 2, durationMs: 41_000 });
    expect(activityLabel(summary)).toBe('3 steps · 2 agents · 41 s');
  });

  it('un run qui court n’a pas de durée, et la ligne n’en invente pas', () => {
    const summary = activitySummary([turn()], {
      createdAt: new Date('2026-09-18T09:00:00Z'),
      completedAt: null,
    });
    expect(summary.durationMs).toBeNull();
    expect(activityLabel(summary)).toBe('1 step · 1 agent');
  });
});
