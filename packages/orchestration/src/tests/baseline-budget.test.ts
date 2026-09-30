// baseline-budget.test.ts — le socle d'un job a un budget, et chaque règle
// gardée y garde sa phrase.
//
// Mesuré le 01/10/2026 sur origin/main 7fae63ae, orchestrateur, tous les
// outils : le socle (`buildBaselineBlock`, surface job) faisait 20 304
// caractères, envoyés à CHAQUE job de CHAQUE agent. La même règle y était dite
// trois fois (Verify : cœur, puis Signals, Excuses, Anti-patterns), deux
// sections redisaient ce que le runner impose déjà (Anti-loop limits : les
// compteurs de chain-counters.ts ; Confirm destructive actions : la porte
// d'approbation, qui faisait confirmer l'utilisateur deux fois), et un
// paragraphe n'allait qu'à certains modèles, choisis par une regex sur leur nom.
//
// Le budget est un test, sur le modèle de chat-surface-cost.test.ts : faire
// regrossir le socle devient une décision, pas une dérive.
//
// Le seuil, 5 000, et pourquoi il n'est pas plus bas : le socle budgété en
// fait 4 843. Chacune des sections retirées, remise seule, le fait sortir du
// budget, la plus petite (le bloc d'approbation, 343 car.) comprise. Descendre
// le socle sous ~4 660 sans baisser le seuil rouvrirait ce trou : la marge est
// voulue petite, une phrase, pas une section.
//
// Ce que le budget NE compte PAS : le bloc de rôle (`## Delegation discipline`
// / `## Capitalize what you learn`), refondu avec le mode d'emploi de l'équipe
// par un autre chantier du lot. Il reste tenu par le plafond du socle ENTIER,
// plus bas.

import { describe, it, expect } from 'vitest';
import { buildBaselineBlock } from '../agent-baseline';
import { KNOWN_TOOL_NAME_UNIVERSE } from '../router/tool-availability';

/** Le job le plus large : tous les outils connus, donc toutes les skills de socle. */
const ALL_TOOLS = [...KNOWN_TOOL_NAME_UNIVERSE];
const socle = (role: 'orchestrator' | 'agent'): string =>
  buildBaselineBlock({ role, availableTools: ALL_TOOLS });

/** Les sections `## ` d'un bloc, titre compris. */
const sections = (block: string): string[] => block.split(/\n\n(?=## )/);

/** Le bloc de rôle, tenu par un autre chantier (voir l'en-tête). */
const ROLE_SECTIONS = ['## Delegation discipline', '## Capitalize what you learn'];
const budgeted = (block: string): string =>
  sections(block)
    .filter((s) => !ROLE_SECTIONS.some((h) => s.startsWith(h)))
    .join('\n\n');

describe('le socle d’un job tient dans son budget', () => {
  for (const role of ['orchestrator', 'agent'] as const) {
    it(`${role} : le socle hors bloc de rôle ≤ 5 000 caractères`, () => {
      const block = socle(role);
      // Le filtre retire le bloc de rôle et seulement lui : sans ces
      // assertions, le test pourrait mesurer un bloc vidé.
      expect(sections(block).some((s) => ROLE_SECTIONS.some((h) => s.startsWith(h)))).toBe(true);
      expect(budgeted(block)).not.toMatch(/## (Delegation discipline|Capitalize what you learn)/);
      for (const kept of ['## Verify before done', '## Workspace hygiene', '## Memory discipline'])
        expect(budgeted(block)).toContain(kept);
      const n = budgeted(block).length;
      expect(n, `socle budgété : ${n} car. (19 651 avant le régime)`).toBeLessThanOrEqual(5_000);
    });

    it(`${role} : le socle entier, bloc de rôle compris, ≤ 6 000 caractères`, () => {
      const n = socle(role).length;
      expect(n, `socle entier : ${n} car. (20 304 avant le régime)`).toBeLessThanOrEqual(6_000);
    });
  }
});

describe('chaque règle gardée garde une phrase repérable', () => {
  // Une ligne par règle : si une réécriture la perd, c'est ce cas qui rougit,
  // avec son nom. L'origine est dans le fichier qui porte la phrase.
  it.each([
    ['parler la langue de l’utilisateur', "Reply in the language of the user's latest message"],
    ['ne jamais traduire le code', 'Never translate code, identifiers'],
    ['une preuve de CE tour', 'without evidence from THIS turn'],
    ['relire un fichier écrit', 'After a `file_write`, `file_read` the path'],
    [
      'ne jamais inventer une sortie d’outil',
      'Never write a tool output you did not actually get back',
    ],
    ['lire avant d’affirmer (f423887a)', 'Read before you assert'],
    ['désactiver, pas supprimer', 'deactivate rather than delete'],
    ['ses propres messages sont une preuve', 'Your own earlier messages are evidence'],
    ['le travail délégué se lit dans le ledger (ca672ced)', 'task ledger entries of your history'],
    ['lire avant d’écrire', 'Read before you write'],
    ['échouer bruyamment', 'Fail loud'],
    [
      'être décisif, pour tout modèle (ex-NEEDS_FIRMER_VERIFY)',
      'take the fewest steps that finish the task',
    ],
    ['nodal_docs avant de refuser (#329)', 'Look before you say no'],
    ['répondre par un endroit (#329)', 'the answer is a PLACE'],
    ['une question sur Nodal est à toi (#455)', 'never delegate it to a teammate'],
    ['corriger un souvenir faux', 'mark_memory_outdated'],
    ['pas d’interdiction de chercher', 'discovery ban'],
    ['le dossier propre d’abord (26/08)', 'that folder is where your work goes'],
    [
      'pas de `shared/` inventé dans son dossier (26/08)',
      'do not invent a `shared/` path inside it',
    ],
    ['un dossier par genre, dans le partagé', 'One folder per kind in the shared workspace'],
    ['les valeurs d’un run sont des arguments (ec21edb5)', 'takes its run values'],
    ['rien dans le dossier d’une skill', "Never write generated files into a skill's folder"],
  ])('%s', (_rule, phrase) => {
    for (const role of ['orchestrator', 'agent'] as const) {
      expect(socle(role), `${role} a perdu « ${phrase} »`).toContain(phrase);
    }
  });
});

describe('les sections retirées ne reviennent pas', () => {
  // Chacune est tenue ailleurs, au moment où elle sert :
  //  - Anti-loop limits : chain-counters.ts DEFAULT_LIMITS (15 chaînes, 50
  //    appels par tour, profondeur 3) et le détecteur de non-progrès du runner ;
  //  - Confirm destructive actions : la porte d'approbation (destructive_gate,
  //    tools/src/execute.ts) et sa carte ;
  //  - When a call has to be approved : PURPOSE_DESCRIPTION dans le schéma et
  //    missingPurposeInstruction au refus (tools/src/purpose.ts) ;
  //  - Especially you : la ligne « Be decisive » de safe-tool-use, pour tous ;
  //  - Signals, Excuses, Anti-patterns : redites du cœur de Verify gardé ;
  //  - One workflow = one graph, Skill bundles are code : une ligne chacune
  //    dans l'hygiène ; le détail des bundles est dans `run_skill_script` (sa
  //    description et l'avertissement `bundle_pollution`).
  const GONE = [
    'Anti-loop limits',
    'Max 50 tool calls',
    'Confirm destructive',
    'Signals that you are about to skip',
    'The excuses, and what they are actually worth',
    'Anti-patterns',
    'When a call has to be approved',
    'Especially you',
    'Detection rules',
    'One workflow = one graph',
    'Skill bundles are code, not storage',
  ];
  for (const surface of ['job', 'chat'] as const) {
    for (const role of ['orchestrator', 'agent'] as const) {
      it(`${surface} / ${role}`, () => {
        const block = buildBaselineBlock({ role, surface, availableTools: ALL_TOOLS });
        const found = GONE.filter((g) => block.includes(g));
        expect(found, `sections retirées revenues : ${found.join(', ')}`).toEqual([]);
      });
    }
  }
});
