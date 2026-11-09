// reply-language.test.ts — l'agent répond dans la langue du message auquel il
// répond, et il n'existe aucune langue préférée (#986).
//
// Mesuré le 04/11/2026 : dans une conversation EN ANGLAIS, le root a accusé
// réception d'un `run_task` en français (« Je lance la recherche… »). Rejeu du
// tour dit, 5 tirages par variante : le déclencheur était le souvenir
// « Operator — preferred language: Francais » qu'écrivait l'entretien d'accueil
// (0 réponse française sur 10 sans lui), et une règle qui nommait cette
// préférence, même pour la faire perdre, aggravait le défaut (6/10).
//
// Décision de Quentin : pas de langue préférée du tout. L'entretien ne la
// demande plus, la migration 0162 archive ces souvenirs, et la règle du socle
// (`language-mirror`) n'en nomme aucune. Ces tests regardent le prompt envoyé
// au modèle — jamais sa réponse — sur toutes les surfaces, avec la ligne de
// l'entretien présente dans la base telle que la migration la laisse :
// archivée.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentMemory, eq } from '@nodal-agents/db';
import { openingMessages, SYSTEM_PROMPT_CACHE_BOUNDARY } from '@nodal-agents/shared';
import { buildSystemPrompt } from '../system-prompt';

/** La règle, telle que le modèle la lit. */
const RULE =
  'Reply in the language of the message you are answering; a run with no message from the ' +
  'person (a scheduled run) uses the language of the request or task text it carries.';

const deployment = { os: 'Windows 11', networkMode: 'loopback' as const };
const conversation = {
  id: 'conv-langue-1',
  priorTurns: 1,
  openedByCommand: false,
  currentProject: null,
  registeredProjects: [],
};

/** Chaque façon dont un prompt part au modèle, avec son contexte réel. */
const SURFACES: Array<[string, Record<string, unknown>]> = [
  ['un tour de chat', { origin: 'dashboard', surface: 'chat', conversation, deployment }],
  [
    'un tour de chat parlé',
    { origin: 'dashboard', surface: 'chat', conversation, deployment, replyRendering: 'spoken' },
  ],
  ['un job lancé depuis le chat', { origin: 'dashboard', conversation, deployment }],
  ['un job venu de Telegram', { origin: 'telegram', telegramChatId: '42', deployment }],
  [
    'un job venu du serveur MCP',
    { origin: 'mcp', deployment, triggerContext: { type: 'mcp', caller: 'client' } },
  ],
  ['un job délégué', { origin: 'api', isDelegated: true, delegationDepth: 1, deployment }],
  ['une session CLI de codage', { origin: 'api', surface: 'cli-runtime', deployment }],
  [
    'un job planifié',
    {
      origin: 'cron',
      deployment,
      triggerContext: { type: 'cron', scheduleName: 'Revue du matin', prevRunAt: null },
    },
  ],
];

describe('la langue du message, et aucune langue préférée @cap:parler-a-un-agent/moteur', () => {
  let db: TestDb;
  let agent: Record<string, unknown>;
  beforeAll(async () => {
    ({ db } = await spinUpTestDb());
    const seed = await seedMinimal(db);
    // La ligne exacte que l'entretien écrivait (souvenir d'espace, sans agent),
    // ARCHIVÉE comme la migration 0162 la laisse — et un vrai souvenir actif à
    // côté, pour que le bloc mémoire soit bien rendu.
    await db.insert(agentMemory).values([
      {
        entityId: seed.entityId,
        agentId: null,
        category: 'preference',
        fact: 'Operator — preferred language: Francais',
        importance: 5,
        source: 'manual',
        archived: true,
      },
      {
        entityId: seed.entityId,
        agentId: null,
        category: 'context',
        fact: 'Operator — what to call them: Quentin',
        importance: 3,
        source: 'manual',
      },
    ]);
    const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId)).limit(1);
    agent = row as Record<string, unknown>;
  });

  it.each(SURFACES)('%s porte la règle, et ne nomme aucune langue préférée', async (_l, ctx) => {
    const prompt = await buildSystemPrompt(agent as never, db, ctx as never);
    expect(prompt).toContain(RULE);
    // Le bloc mémoire est bien là : l'absence ci-dessous n'est pas celle d'un
    // prompt sans mémoire.
    expect(prompt).toContain('Operator — what to call them: Quentin');
    expect(prompt).not.toMatch(/preferred language/i);
    expect(prompt).not.toMatch(/language preference|preferred .{0,20}language/i);
  });

  // La mémoire OUVRE la moitié volatile, loin du message de la personne : à la
  // fin du prompt, des notes écrites dans une autre langue tiraient l'accusé de
  // réception vers leur langue (10/20 → 4/20 une fois déplacée, rejeu du tour
  // dit). Vérifié sur chaque surface, avec tous les blocs qui la suivent.
  // Mutation vérifiée : l'ordre d'avant (runtime puis mémoire) → rouge partout.
  it.each(SURFACES)(
    '%s : la mémoire ouvre la moitié volatile, avant Runtime, Job context et Conversation',
    async (_l, ctx) => {
      const prompt = await buildSystemPrompt(agent as never, db, ctx as never);
      const at = (heading: string): number => prompt.indexOf(`\n## ${heading}\n`);
      const memory = at('Persistent memory');
      const boundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
      expect(memory, 'no memory block').toBeGreaterThan(-1);
      expect(boundary, 'no cache boundary').toBeGreaterThan(-1);
      // Dans la moitié volatile, et rien d'autre de volatil avant elle.
      expect(memory).toBeGreaterThan(boundary);
      expect(prompt.slice(boundary + SYSTEM_PROMPT_CACHE_BOUNDARY.length, memory).trim()).toBe('');
      const after = ['Runtime', 'Job context', 'Conversation']
        .map((h) => [h, at(h)] as const)
        .filter(([, i]) => i > -1);
      // Runtime et Job context sont sur toutes ces surfaces (déploiement, contexte).
      expect(after.map(([h]) => h)).toEqual(expect.arrayContaining(['Runtime', 'Job context']));
      for (const [heading, i] of after)
        expect(i, `${heading} before memory`).toBeGreaterThan(memory);
    },
  );

  it('le chat situe la mémoire là où elle est : au-dessus', async () => {
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'dashboard',
      surface: 'chat',
      conversation,
      deployment,
    } as never);
    expect(prompt).toContain('(your durable facts are loaded above)');
    expect(prompt.indexOf('\n## Persistent memory\n')).toBeLessThan(
      prompt.indexOf('(your durable facts are loaded above)'),
    );
  });

  it('un job planifié se sait planifié, et reçoit le texte de tâche dont la règle parle', async () => {
    const task = 'Every morning, summarise the three most important emails of the night.';
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'cron',
      deployment,
      task,
      triggerContext: { type: 'cron', scheduleName: 'Revue du matin', prevRunAt: null },
    } as never);
    expect(prompt).toContain('- Scheduled run of "Revue du matin".');
    expect(prompt).toContain(
      'a run with no message from the person (a scheduled run) uses the language of the request or task text it carries',
    );
    // Le texte de tâche est le message d'ouverture du job (execute.ts,
    // `openingMessages(job.task, job.handoffNote)`) : c'est lui que le modèle
    // reçoit, et lui que la règle désigne.
    expect(openingMessages(task, null)).toEqual([{ role: 'user', content: task }]);
  });

  it('l’exemple du chat n’est plus une phrase française à recopier', async () => {
    // Le 04/11, l'accusé de réception fautif était « Je lance la recherche… » :
    // mot pour mot l'exemple que la surface chat donnait au modèle.
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'dashboard',
      surface: 'chat',
      conversation,
      deployment,
    } as never);
    expect(prompt).not.toContain('Je lance');
    expect(prompt).toContain('(e.g. "I\'m starting X…") does NOT start anything');
  });
});
