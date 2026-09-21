// owner-copy.test.ts — tout outil que le PRODUIT expédie porte les DEUX textes
// que lit son propriétaire : un titre (`label`) et un résumé (`summary`).
//
// Pourquoi ce fichier (issue #382) : l'onglet Approvals affichait la
// `description` de chaque outil, c'est-à-dire le texte écrit POUR LE MODÈLE.
// Long, impératif, plein de « do NOT » adressés à quelqu'un d'autre. Deux
// lecteurs, deux textes — et rien ne garantissait que le second existe.
//
// Pourquoi par ÉNUMÉRATION du registre, comme cards.test.ts : une liste écrite
// à la main vieillit en silence. Un outil ajouté demain sans `label` fait
// rougir ce fichier EN SE NOMMANT, sans qu'aucune liste n'ait à être tenue.
//
// Pourquoi, EN PLUS, une table épinglant les vingt outils toujours disponibles :
// l'énumération prouve la PRÉSENCE d'un texte, pas sa justesse. Ces vingt
// phrases sont celles que Quentin a écrites et relues contre le code (#382) ;
// les changer se fait à découvert, dans le diff.
//
// Ce que ce test NE couvre PAS, et le dit : les outils TIERS (serveurs MCP,
// adaptateurs de connecteurs) n'ont pas ces champs — ils sont construits
// ailleurs, et l'écran retombe pour eux sur leur `name`/`description`
// d'origine. Les opérations de connecteurs qui portent déjà les deux textes
// sont vérifiées par la suite de leur adaptateur.

import { describe, it, expect } from 'vitest';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { createListConversationsTool } from '../builtin/list-conversations';
import {
  createTelegramSendMessageTool,
  createSendImageTool,
  createSendFileTool,
  createSendVideoTool,
  createSendAudioTool,
  createSendVoiceTool,
} from '../communication';
import type { ToolDefinition } from '../types';
import type { z } from 'zod';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

const registry = createToolRegistry();
registerBuiltins(registry);

/** Les outils de capacité, instanciés par job dans le runner — jamais dans le registre. */
const capabilityTools: AnyTool[] = [
  createTelegramSendMessageTool(),
  createSendImageTool(),
  createSendFileTool(),
  createSendVideoTool(),
  createSendAudioTool(),
  createSendVoiceTool(),
  createListConversationsTool(),
] as unknown as AnyTool[];

const productTools: AnyTool[] = [...registry.list(), ...capabilityTools];

/**
 * Assemblé à l'exécution : un tiret cadratin écrit en clair dans un fichier du
 * dépôt est exactement ce que le grep de la PR cherche à ne plus trouver.
 */
const EM_DASH = String.fromCharCode(0x2014);

/** Les vingt phrases de l'issue #382, mot pour mot. */
const PINNED: Readonly<Record<string, readonly [string, string]>> = {
  return_result: [
    'Finish a task',
    'Report that a task succeeded or is blocked. It sends no answer by itself: the agent delivers its answer in the same step, through the right channel.',
  ],
  ask_user: ['Ask you a question', 'Pause the job until you choose from 2 to 6 options.'],
  register_project: [
    'Create a project',
    'Create a workspace folder and add it to Spaces, when you request a project or choose "new project". Asks for approval unless you set a rule. Existing projects and code folders with a manifest do not need it.',
  ],
  declare_verification: [
    'Record how a project was checked',
    "Record checks the agent already ran on a project it created or changed. Each check must fail when the project is unhealthy, and must have run from inside that project's folder.",
  ],
  skill_view: [
    'Read its skills',
    'Load the full instructions for a relevant skill or tool before using it.',
  ],
  list_models: [
    'List available models',
    "Get valid model IDs before assigning or changing an agent's model.",
  ],
  list_schedules: [
    'List schedules',
    "See this workspace's schedules, including their status and next run.",
  ],
  save_memory: [
    'Remember a fact',
    'Save a lasting preference or fact that may help with future work. Temporary details are skipped.',
  ],
  query_memory: [
    'Recall a fact',
    'Search saved memories for relevant preferences, rules, or context.',
  ],
  nodal_docs: [
    'Search product help',
    'Look up how Nodal-Agents works before explaining a feature or saying it is unavailable.',
  ],
  search_history: [
    'Search past work',
    'Find decisions and details from earlier jobs and conversations in this workspace.',
  ],
  mark_memory_helpful: [
    'Mark a memory useful',
    'Give a memory more priority when it materially helped with a job.',
  ],
  mark_memory_outdated: [
    'Mark a memory outdated',
    'Archive a memory that newer information has replaced.',
  ],
  web_search: [
    'Search the web',
    'Search online using the configured provider, or a free search option if none is configured.',
  ],
  dashboard_publish: [
    'Publish the job result',
    'Put the full answer on the Jobs dashboard and pass it to any dependent task.',
  ],
  file_read: [
    'Read a workspace file',
    'Read file contents, a section at a time for large files. Files over 50 MiB cannot be read with this tool.',
  ],
  file_write: [
    'Write a workspace file',
    'Create or replace a file safely. For a small change to an existing file, use Edit a workspace file. Maximum write size: 1 MiB.',
  ],
  file_edit: [
    'Edit a workspace file',
    'Replace an exact part of a file while leaving the rest untouched. The edit fails if the target text is missing or ambiguous.',
  ],
  file_list: [
    'List workspace files',
    'Show files in a workspace folder, with optional filters. Returns up to 500 entries.',
  ],
  file_search: [
    'Search workspace files',
    'Find matching file names or text inside workspace files.',
  ],
};

describe('les deux textes du propriétaire, sur tout outil du produit @cap:assigner-outils/moteur', () => {
  it('le registre est bien peuplé (sinon tout ce qui suit passerait à vide)', () => {
    expect(productTools.length).toBeGreaterThan(60);
  });

  it('chaque outil déclare un titre court, qui n’est pas son identifiant', () => {
    const missing = productTools.filter((t) => !t.label).map((t) => t.name);
    expect(missing, 'outils sans label').toEqual([]);

    for (const tool of productTools) {
      expect(tool.label, `${tool.name} : titre vide`).not.toBe('');
      expect(tool.label, `${tool.name} : titre = identifiant`).not.toBe(tool.name);
      expect(tool.label!.length, `${tool.name} : titre trop long`).toBeLessThanOrEqual(40);
      expect(tool.label!.endsWith('.'), `${tool.name} : un titre n'est pas une phrase`).toBe(false);
    }
  });

  it('chaque outil déclare un résumé rédigé, distinct du texte du modèle', () => {
    const missing = productTools.filter((t) => !t.summary).map((t) => t.name);
    expect(missing, 'outils sans summary').toEqual([]);

    for (const tool of productTools) {
      expect(tool.summary, `${tool.name} : résumé vide`).not.toBe('');
      expect(tool.summary, `${tool.name} : résumé = texte du modèle`).not.toBe(tool.description);
      expect(tool.summary!.endsWith('.'), `${tool.name} : résumé sans point final`).toBe(true);
      // Deux phrases au plus : au-delà, c'est une notice, et personne ne la lit.
      const sentences = tool.summary!.split('. ').length;
      expect(sentences, `${tool.name} : ${sentences} phrases`).toBeLessThanOrEqual(3);
    }
  });

  it('aucun tiret cadratin dans un texte que lit une personne', () => {
    const guilty = productTools
      .filter((t) => (t.label ?? '').includes(EM_DASH) || (t.summary ?? '').includes(EM_DASH))
      .map((t) => t.name);
    expect(guilty).toEqual([]);
  });

  it('les vingt outils toujours disponibles portent les phrases de l’issue #382', () => {
    for (const [name, [label, summary]] of Object.entries(PINNED)) {
      const tool = productTools.find((t) => t.name === name);
      expect(tool, `${name} absent du registre`).toBeDefined();
      expect(tool!.label, `${name} : titre`).toBe(label);
      expect(tool!.summary, `${name} : résumé`).toBe(summary);
    }
  });
});
