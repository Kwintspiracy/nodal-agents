// chat-surface-cost.test.ts — la surface `chat` ne reçoit que ce qu'elle peut
// obéir, et ça coûte deux fois moins de jetons.
//
// Mesuré le 12/09/2026 sur la base de Quentin : le prompt système d'un tour de
// chat pesait ~9 000 jetons, dont ~3 900 de skills « baseline » et ~1 800 de
// bloc d'équipe. Or, sur cette surface, l'agent a UN outil : `run_task`. Il ne
// peut ni lire un fichier avant de l'écrire (« Verify before done », « Safe
// tool use », « Workspace hygiene »), ni `save_memory` (« Memory discipline »),
// ni `assign_*` (le bloc d'équipe). Chaque « you MUST » de ces textes était un
// ordre inexécutable — exactement le défaut fermé pour `cli-runtime`, et par la
// même règle : un texte qui prescrit des outils absents de la surface ne s'y
// injecte pas.
//
// La règle vit dans le CATALOGUE (invariant #3) : chaque skill système déclare
// les surfaces où son texte peut être suivi. Ici, on prouve ce que le prompt
// assemblé contient et ne contient plus — et on le mesure.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentAssignments,
  agentSkills,
  agentSkillAssignments,
  agentWorkspaces,
  eq,
} from '@nodal-agents/db';
import { buildSystemPrompt } from '../system-prompt';
import { buildBaselineBlock } from '../agent-baseline';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let agent: Record<string, unknown>;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  const [sub] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Sous Agent Chat',
      slug: 'sous-agent-chat',
      personality: 'Je fais des choses.',
      model: 'test-model',
      role: 'agent',
      active: true,
    })
    .returning();
  await db.insert(agentAssignments).values({
    entityId: seed.entityId,
    orchestratorId: seed.agentId,
    subAgentId: (sub as { id: string }).id,
  });
  await db.update(agents).set({ role: 'orchestrator' }).where(eq(agents.id, seed.agentId));

  // Passe 2 de la revue, constat 1 : la fixture d'origine n'avait NI dossier,
  // NI skill, NI canal, NI conversation — et quatre blocs qui prescrivent des
  // outils se déclenchent précisément là-dessus. Un prompt de chat nu ne prouve
  // rien de la promesse « rien que d'exécutable ».
  await db.insert(agentWorkspaces).values([
    { entityId: seed.entityId, agentId: seed.agentId, label: 'dev', path: '/tmp/dev-chat' },
    { entityId: seed.entityId, agentId: seed.agentId, label: 'notes', path: '/tmp/notes-chat' },
  ]);
  const [skill] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      slug: 'command-execution',
      name: 'Command execution',
      description: 'Run commands.',
      content: '## Command execution\n\nUse `run_command`.',
    })
    .returning();
  await db.insert(agentSkillAssignments).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    skillId: (skill as { id: string }).id,
  });

  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  agent = row as Record<string, unknown>;
});

const conversation = {
  id: 'conv-chat-1',
  priorTurns: 3,
  openedByCommand: false,
  currentProject: null,
  registeredProjects: [
    { name: 'Portail', path: '/tmp/dev-chat/portail', kind: 'documents' as const },
  ],
};

const chat = () =>
  buildSystemPrompt(agent as never, db, {
    origin: 'dashboard',
    surface: 'chat',
    conversation,
  } as never);
const job = () => buildSystemPrompt(agent as never, db, { origin: 'api' } as never);

describe('la surface chat ne reçoit que ce qu’elle peut obéir', () => {
  it('le TEXTE de ces skills ne part pas sur le chat — ce qui en reste vrai, oui', async () => {
    const c = await chat();
    const j = await job();
    // « Workspace hygiene » n'a rien à dire sans outil de fichier : elle se tait.
    expect(j, '## Workspace hygiene manque sur un job').toContain('## Workspace hygiene');
    expect(c, '## Workspace hygiene injecté sur le chat').not.toContain('## Workspace hygiene');

    // Les deux autres, elles, ont écrit une version sans outil (revue de la
    // dette, passe 1, constat 1). Leur TITRE revient donc sur le chat, et
    // l'assertion d'origine — « ce titre est absent » — refusait exactement le
    // correctif (passe 2, constat 2). Ce qui doit rester absent, c'est le texte
    // de JOB : les phrases qui prescrivent un outil.
    for (const titre of ['## Verify before done', '## Safe tool use']) {
      expect(j, `${titre} manque sur un job`).toContain(titre);
      expect(c, `${titre} ne dit plus rien sur le chat`).toContain(titre);
    }
    for (const phraseDeJob of [
      'after every `file_write` or equivalent',
      '`file_read` before `file_write`',
      '### Anti-loop limits',
    ]) {
      expect(j, `« ${phraseDeJob} » manque sur un job`).toContain(phraseDeJob);
      expect(c, `« ${phraseDeJob} » injectée sur le chat`).not.toContain(phraseDeJob);
    }
  });

  it('« Language mirror » reste : parler la langue de l’utilisateur ne demande aucun outil', async () => {
    expect(await chat()).toContain('## Language mirror');
  });

  it('la discipline de mémoire (save_memory) est absente du chat', async () => {
    expect(await job()).toContain('## Memory discipline');
    expect(await chat()).not.toContain('## Memory discipline');
  });

  it('le bloc d’équipe est une CONNAISSANCE, et dit comment faire faire le travail : run_task', async () => {
    const c = await chat();
    expect(c).toContain('## Your team');
    expect(c).toContain('Sous Agent Chat');
    // Pas de manuel de délégation : ces outils n'existent pas ici.
    expect(c).not.toContain('`assign_<agent>`');
    expect(c).not.toContain('`create_task` — parallel fan-out');
    // Mais pas non plus « tu ne peux rien leur confier » : le chat escalade.
    expect(c).not.toContain('there is no way for you to hand work to them');
    expect(c).toContain('run_task');
  });

  it('coûte au moins 40 % de moins qu’un job — mesuré, pas promis', async () => {
    const c = (await chat()).length;
    const j = (await job()).length;
    expect(c, `chat ${c} car. vs job ${j} car.`).toBeLessThan(j * 0.6);
  });
});

// ─── Revue Codex de la dette, passe 1 ────────────────────────────────────────

describe('la promesse « rien que d’exécutable » se vérifie sur le TEXTE, pas sur les titres', () => {
  // Constat 2 de la revue post-merge. Les trois assertions ci-dessus lisent des
  // TITRES : elles prouvent que trois blocs sont partis, pas que rien de ce qui
  // reste ne prescrit un outil absent. Deux blocs en prescrivaient encore —
  // « Capitalize what you learn » ordonne `save_memory`, et le renforcement des
  // modèles non frontières ordonne `skill_view` / `run_skill_script`.
  //
  // La liste ci-dessous est celle du chat, à la source : `CHAT_TOOLS` dans
  // `apps/runner/src/chat/run-chat-turn.ts` n'a qu'une entrée.
  const OUTILS_DU_CHAT = new Set(['run_task']);

  // Les mots en `snake_case` qui ne sont PAS des outils. Le renforcement nommait
  // `skill_view` sans accents graves : chercher les seuls noms entre accents
  // graves laissait passer exactement le bloc que la revue a trouvé. On prend
  // donc tout `snake_case`, et on énumère ce qui n'est pas un outil — la liste
  // est courte, et un ajout s'y fait en connaissance de cause.
  const PAS_DES_OUTILS = new Set(['tool_result', 'agent_jobs', 'snake_case']);

  /** Les noms d’outils que le prompt PRESCRIT, avec ou sans accents graves. */
  const outilsPrescrits = (prompt: string): string[] => {
    const vus = new Set<string>();
    for (const m of prompt.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
      const nom = m[1]!;
      if (!OUTILS_DU_CHAT.has(nom) && !PAS_DES_OUTILS.has(nom)) vus.add(nom);
    }
    return [...vus].sort();
  };

  it('aucun bloc du chat ne nomme un outil que le chat n’a pas', async () => {
    const restants = outilsPrescrits(await chat());
    expect(restants, `ordres inexécutables sur le chat : ${restants.join(', ')}`).toEqual([]);
  });

  it('et le job, lui, les nomme bel et bien — sinon ce test ne prouverait rien', async () => {
    expect(outilsPrescrits(await job()).length).toBeGreaterThan(3);
  });

  // Le prompt assemblé ci-dessus ne passe que par UNE combinaison : un
  // orchestrateur sur `test-model`. Les deux blocs que la revue a trouvés
  // vivent dans les autres — le rôle `agent`, et un modèle non frontière. Ils
  // se prennent à la source.
  it('un agent SIMPLE sur le chat ne reçoit pas non plus d’ordre `save_memory`', () => {
    const bloc = buildBaselineBlock('test-model', { role: 'agent', surface: 'chat' });
    expect(outilsPrescrits(bloc), 'le bloc du rôle worker prescrit encore un outil').toEqual([]);
    // Et sur un job, il le prescrit : la règle n'a pas disparu du produit.
    expect(buildBaselineBlock('test-model', { role: 'agent' })).toContain('save_memory');
  });

  it('un modèle non frontière sur le chat non plus', () => {
    const bloc = buildBaselineBlock('minimax-m3', { role: 'agent', surface: 'chat' });
    expect(outilsPrescrits(bloc), 'le renforcement prescrit encore un outil').toEqual([]);
    // Le renforcement lui-même reste, sur un job, avec ses outils.
    const surJob = buildBaselineBlock('minimax-m3', { role: 'agent' });
    expect(surJob).toContain('skill_view');
  });
});
