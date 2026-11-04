// reply-language.test.ts — la langue du message auquel on répond gagne sur la
// langue préférée enregistrée (#986).
//
// Mesuré le 04/11/2026 : dans une conversation EN ANGLAIS, le root a accusé
// réception d'un `run_task` en français (« Je lance la recherche… »), puis rendu
// le résultat du job en anglais. Le prompt portait deux règles sans arbitre :
// « Mirror the user's language and tone » (personnalité par défaut de
// l'onboarding) et le souvenir « Operator — preferred language: Francais »
// (importance 5), écrit par l'entretien d'accueil.
//
// La préséance se dit UNE fois, dans le socle (`language-mirror`, catalogue),
// qui part sur toutes les surfaces. Ces tests regardent le prompt envoyé au
// modèle — jamais sa réponse — sur plus que le scénario du ticket : tour de
// chat, job lancé depuis le chat, job planifié, job délégué, canal, session CLI,
// et un workspace qui n'a enregistré aucune langue.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentMemory, eq } from '@nodal-agents/db';
import { buildSystemPrompt } from '../system-prompt';

/** La phrase de préséance, telle que le modèle la lit. */
const PRECEDENCE =
  'Reply in the language of the message you are answering, even over a preferred language the ' +
  'person has stated: that preference applies when no message of theirs is there to mirror ' +
  '(a scheduled run, an announcement, a notification).';
/** Ce qui s'applique quand il n'y a rien à refléter. */
const NOTHING_TO_MIRROR = 'with nothing to mirror, use the stated preference, or English';

const PREFERRED = 'Operator — preferred language: Francais';
const deployment = { os: 'Windows 11', networkMode: 'loopback' as const };
const conversation = {
  id: 'conv-langue-1',
  priorTurns: 1,
  openedByCommand: false,
  currentProject: null,
  registeredProjects: [],
};

async function workspace(withPreferredLanguage: boolean): Promise<{
  db: TestDb;
  agent: Record<string, unknown>;
}> {
  const { db } = await spinUpTestDb();
  const seed = await seedMinimal(db);
  if (withPreferredLanguage) {
    // La ligne exacte que l'entretien d'accueil écrit (OnboardingFlow.tsx).
    await db.insert(agentMemory).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      category: 'preference',
      fact: PREFERRED,
      importance: 5,
    });
  }
  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId)).limit(1);
  return { db, agent: row as Record<string, unknown> };
}

/** Chaque façon dont un prompt part au modèle, avec son contexte réel. */
const SURFACES: Array<[string, Record<string, unknown>]> = [
  ['un tour de chat', { origin: 'dashboard', surface: 'chat', conversation, deployment }],
  [
    'un tour de chat parlé',
    {
      origin: 'dashboard',
      surface: 'chat',
      conversation,
      deployment,
      replyRendering: 'spoken',
    },
  ],
  ['un job lancé depuis le chat', { origin: 'dashboard', conversation, deployment }],
  ['un job venu de Telegram', { origin: 'telegram', telegramChatId: '42', deployment }],
  [
    'un job venu du serveur MCP',
    {
      origin: 'mcp',
      deployment,
      triggerContext: { type: 'mcp', caller: 'client' },
    },
  ],
  ['un job délégué', { origin: 'api', isDelegated: true, delegationDepth: 1, deployment }],
  ['une session CLI de codage', { origin: 'api', surface: 'cli-runtime', deployment }],
];

describe('la langue du message gagne sur la langue préférée @cap:parler-a-un-agent/moteur', () => {
  let db: TestDb;
  let agent: Record<string, unknown>;
  beforeAll(async () => {
    ({ db, agent } = await workspace(true));
  });

  it.each(SURFACES)('%s porte la préséance ET la langue préférée', async (_label, ctx) => {
    const prompt = await buildSystemPrompt(agent as never, db, ctx as never);
    // Les deux règles arrivent au modèle — et l'une dit maintenant laquelle gagne.
    expect(prompt).toContain(PREFERRED);
    expect(prompt).toContain(PRECEDENCE);
  });

  it('un job planifié se sait planifié, et la règle l’envoie vers la langue préférée', async () => {
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'cron',
      deployment,
      triggerContext: { type: 'cron', scheduleName: 'Revue du matin', prevRunAt: null },
    } as never);
    // Le job ne devine pas qu'il est planifié : le bloc Runtime le dit…
    expect(prompt).toContain('- Scheduled run of "Revue du matin".');
    // … et la règle range ce cas-là du côté de la préférence, pas du message.
    expect(prompt).toContain('(a scheduled run, an announcement, a notification)');
    expect(prompt).toContain(NOTHING_TO_MIRROR);
    expect(prompt).toContain(PREFERRED);
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

describe('un workspace sans langue préférée @cap:parler-a-un-agent/moteur', () => {
  let db: TestDb;
  let agent: Record<string, unknown>;
  beforeAll(async () => {
    ({ db, agent } = await workspace(false));
  });

  it.each(SURFACES)(
    '%s : la règle tient, sans citer un souvenir qui n’existe pas',
    async (_l, ctx) => {
      const prompt = await buildSystemPrompt(agent as never, db, ctx as never);
      expect(prompt).not.toContain('preferred language:');
      expect(prompt).not.toContain('## Persistent memory');
      // La préférence n'est nommée que comme condition (« a preferred language
      // the person has stated »), jamais comme un fait (« your preferred
      // language is », « the preferred language in memory »).
      expect(prompt).toContain(PRECEDENCE);
      expect(prompt).not.toMatch(/\bthe preferred language (in|from) (your )?memory\b/i);
      expect(prompt).not.toMatch(/\byour preferred language is\b/i);
      // Sans préférence ni message : l'anglais, dit explicitement.
      expect(prompt).toContain(NOTHING_TO_MIRROR + ' if there is none yet');
    },
  );
});
