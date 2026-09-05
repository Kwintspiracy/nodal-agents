// cards.test.ts — tout outil que le PRODUIT expédie déclare comment son
// résultat se montre, et comment sa sortie remplit cette carte (plan « De la
// maquette au produit », P1).
//
// Pourquoi par ÉNUMÉRATION du registre et non par liste : une liste écrite à
// la main vieillit en silence (voir intent-wiring.test.ts, même leçon). Ici les
// outils sont DÉCOUVERTS — un outil ajouté demain sans `card` fait rougir ce
// fichier en se nommant, sans qu'aucune liste n'ait à être tenue.
//
// Pourquoi, EN PLUS, une table complète nom → carte : la revue (passe 11) a
// montré que l'énumération prouve la PRÉSENCE d'une carte, pas sa JUSTESSE —
// `query_memory: 'text'` passait alors que sa sortie est tabulaire. La table
// épingle chaque choix ; le changer se fait à découvert, dans le diff.
//
// Pourquoi un `present()` par carte à structure : les passes 12 et 13 ont
// montré qu'une étiquette sans forme oblige l'écran à dispatcher par nom quand
// même (`table` : tableau nu ici, `{ sheets }` là). La forme est dans
// @nodal-agents/shared ; ici on vérifie que chaque outil la remplit, sur ses
// VRAIES sorties (voir aussi file-ops.test.ts, run-command.test.ts,
// xlsx.test.ts, execute.test.ts).
//
// Ce que ce test NE couvre PAS, et le dit : les outils tiers (serveurs MCP,
// adaptateurs de connecteurs) ont droit au repli `generic`. Le seul outil MCP
// est construit par une fabrique qui le déclare ; les adaptateurs restent sur
// le repli. Les outils nés dans `orchestration` (`assign_<agent>`,
// `create_task`, `list_tasks`) ne passent pas par ce registre : leurs propres
// suites portent l'assertion (assign-tools.test.ts, task-tools.test.ts).

import { describe, it, expect } from 'vitest';
import { TOOL_CARDS, CARDS_NEEDING_PRESENTER } from '@nodal-agents/shared';
import type { ToolCard } from '@nodal-agents/shared';
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
import {
  cardForTool,
  declaresCard,
  presentToolResult,
  ToolCardError,
  ToolPresentationError,
  TOOL_CARD_GENERIC,
} from '../cards';
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
 * La carte de CHAQUE outil du produit, épinglée. Lire une ligne, c'est lire ce
 * que l'écran montrera pour ce résultat :
 *   text       — une réponse, un accusé (« fait », « erreur : … »)
 *   read       — le contenu d'un document lu
 *   search     — des correspondances
 *   files      — des fichiers écrits, modifiés ou listés
 *   table      — des lignes à colonnes stables ; la charge utile EST le tableau
 *                (`tables[]`), quelle que soit la forme de sortie de l'outil
 *   terminal   — une commande, sa sortie, son code de sortie
 *   sent       — quelque chose est parti vers un canal
 *   checks     — un verdict de vérification
 *   delegation — un travail confié à un autre agent (Nodal ou CLI de code)
 */
const EXPECTED_CARDS: Record<string, ToolCard> = {
  attach_agent: 'text',
  attach_connector: 'text',
  attach_mcp: 'text',
  attach_skill: 'text',
  code_task: 'delegation',
  create_agent: 'text',
  create_connector: 'text',
  create_mcp: 'text',
  create_schedule: 'text',
  create_skill: 'text',
  dashboard_publish: 'sent',
  detach_agent: 'text',
  detach_connector: 'text',
  detach_mcp: 'text',
  detach_skill: 'text',
  docx_append_paragraphs: 'files',
  docx_create: 'files',
  docx_read: 'read',
  docx_replace_text: 'files',
  file_edit: 'files',
  file_list: 'files',
  file_read: 'read',
  file_search: 'search',
  file_write: 'files',
  list_conversations: 'text',
  list_models: 'text',
  list_schedules: 'text',
  mark_memory_helpful: 'text',
  mark_memory_outdated: 'text',
  pptx_append_slides: 'files',
  pptx_create: 'files',
  pptx_read: 'read',
  pptx_replace_text: 'files',
  query_memory: 'table',
  return_result: 'text',
  review_verdict: 'checks',
  run_command: 'terminal',
  run_schedule: 'text',
  run_skill_script: 'terminal',
  save_memory: 'text',
  search_history: 'search',
  send_audio: 'sent',
  send_file: 'sent',
  send_image: 'sent',
  send_video: 'sent',
  send_voice: 'sent',
  skill_file_list: 'files',
  skill_file_read: 'read',
  skill_file_write: 'files',
  skill_view: 'read',
  telegram_send_message: 'sent',
  toggle_schedule: 'text',
  update_agent: 'text',
  update_schedule: 'text',
  update_skill: 'text',
  web_search: 'search',
  xlsx_add_sheet: 'files',
  xlsx_append_rows: 'files',
  xlsx_create: 'files',
  xlsx_delete_columns: 'files',
  xlsx_delete_rows: 'files',
  xlsx_find_cells: 'search',
  xlsx_format_range: 'files',
  xlsx_freeze_panes: 'files',
  xlsx_insert_columns: 'files',
  xlsx_insert_rows: 'files',
  xlsx_merge_cells: 'files',
  xlsx_read: 'table',
  xlsx_set_cell: 'files',
  xlsx_set_column_widths: 'files',
  xlsx_set_range: 'files',
  xlsx_unmerge_cells: 'files',
};

describe('la carte des outils du produit', () => {
  it('le registre expose bien des outils — sinon la boucle serait verte pour rien', () => {
    expect(registry.list().length).toBeGreaterThan(40);
  });

  it('CHAQUE outil natif déclare sa carte, dans le vocabulaire', () => {
    const sansCarte = registry
      .list()
      .filter((t) => !declaresCard(t))
      .map((t) => t.name);
    expect(
      sansCarte,
      `outils natifs sans \`card\` : ${sansCarte.join(', ')} — déclarez comment leur résultat se montre`,
    ).toEqual([]);
  });

  it('CHAQUE outil de capacité (canaux) déclare sa carte', () => {
    const sansCarte = capabilityTools.filter((t) => !declaresCard(t)).map((t) => t.name);
    expect(sansCarte, `outils de capacité sans \`card\` : ${sansCarte.join(', ')}`).toEqual([]);
  });

  it('la carte de chaque outil est CELLE attendue — la table complète, pas dix ancres', () => {
    // Un outil nouveau apparaît ici sans ligne : le diff le nomme et l'auteur
    // écrit la sienne. Un outil requalifié par accident apparaît aussi.
    const reelles = Object.fromEntries(
      productTools
        .map((t): [string, ToolCard] => [t.name, cardForTool(t)])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(reelles).toEqual(EXPECTED_CARDS);
  });

  it('CHAQUE outil à carte structurée dit comment sa sortie la remplit (present)', () => {
    // Nommés un par un : « registerBuiltins a levé » ne dirait pas lequel.
    const muets = productTools
      .filter((t) => t.card !== undefined && CARDS_NEEDING_PRESENTER.includes(t.card))
      .filter((t) => typeof t.present !== 'function')
      .map((t) => `${t.name} (${String(t.card)})`);
    expect(muets, `cartes structurées sans present() : ${muets.join(', ')}`).toEqual([]);
  });

  it('les cartes déclarées couvrent le vocabulaire utile, pas une seule valeur passe-partout', () => {
    // Si tout déclarait `text`, le contrat serait respecté à la lettre et
    // inutile en pratique : l'écran n'aurait rien à dispatcher. `question` est
    // la seule carte sans outil : elle naît d'une approbation, pas d'un outil.
    const utilisees = new Set(productTools.map((t) => cardForTool(t)));
    for (const attendue of TOOL_CARDS) {
      if (attendue === 'question' || attendue === TOOL_CARD_GENERIC) continue;
      expect(utilisees.has(attendue), `aucun outil ne déclare '${attendue}'`).toBe(true);
    }
    // Et aucun outil du produit ne se repose sur le repli.
    expect(utilisees.has(TOOL_CARD_GENERIC)).toBe(false);
  });
});

describe('cardForTool — le repli est `generic` pour une ABSENCE, une erreur pour une INVENTION', () => {
  const base = {
    name: 'tiers',
    description: 'outil tiers',
    inputSchema: {} as z.ZodTypeAny,
    riskLevel: 'read' as const,
    execute: async () => null,
  };

  it("un outil sans carte rend generic — l'aveu, pas une devinette", () => {
    expect(cardForTool(base as AnyTool)).toBe('generic');
    expect(declaresCard(base as AnyTool)).toBe(false);
  });

  it("une carte hors du vocabulaire LÈVE, en nommant l'outil et la valeur", () => {
    // Revue passe 11 : la première version la rabattait sur `generic` — un
    // repli silencieux (invariant #4). Une carte inventée est une violation du
    // contrat, pas une absence.
    const tordu = { ...base, name: 'tordu', card: 'fancy' } as unknown as AnyTool;
    expect(() => cardForTool(tordu)).toThrow(ToolCardError);
    expect(() => declaresCard(tordu)).toThrow(/tool "tordu" declares card "fancy"/);
    expect(() => cardForTool(tordu)).toThrow(/generic/); // le message dit comment réparer
  });

  it("une carte à structure SANS present() lève — une demi-déclaration n'est pas une déclaration", () => {
    const demi = { ...base, name: 'demi', card: 'table' } as AnyTool;
    expect(() => cardForTool(demi)).toThrow(ToolPresentationError);
    expect(() => cardForTool(demi)).toThrow(/declares card "table" but no `present\(\)`/);
  });

  it('une carte déclarée dans le vocabulaire est rendue telle quelle', () => {
    for (const c of TOOL_CARDS) {
      const tool = {
        ...base,
        card: c,
        ...(CARDS_NEEDING_PRESENTER.includes(c)
          ? { present: () => ({ card: 'text', text: '' }) }
          : {}),
      } as AnyTool;
      expect(cardForTool(tool)).toBe(c);
    }
  });

  it("le registre REFUSE un outil à carte inventée ou sans présentateur — au démarrage, pas à l'affichage", () => {
    const local = createToolRegistry();
    const tordu = { ...base, name: 'tordu_registre', card: 'fancy' } as unknown as AnyTool;
    expect(() => local.register(tordu)).toThrow(ToolCardError);
    const demi = { ...base, name: 'demi_registre', card: 'files' } as AnyTool;
    expect(() => local.register(demi)).toThrow(ToolPresentationError);
    // Refusés, donc ABSENTS : rien n'a été enregistré à moitié.
    expect(local.get('tordu_registre')).toBeUndefined();
    expect(local.get('demi_registre')).toBeUndefined();
    expect(local.list()).toEqual([]);
    // Et le même registre accepte toujours un outil sain, ou sans carte.
    local.register({ ...base, name: 'sain', card: 'text' } as AnyTool);
    local.register({ ...base, name: 'muet' } as AnyTool);
    expect(local.list().map((t) => t.name)).toEqual(['sain', 'muet']);
  });
});

describe('presentToolResult — la charge utile que la ligne tool_calls persiste', () => {
  const base = {
    name: 'p',
    description: '',
    inputSchema: {} as z.ZodTypeAny,
    riskLevel: 'read' as const,
    execute: async () => null,
  };

  it('carte text sans présentateur : la sortie en texte, un objet devient du JSON lisible', () => {
    expect(presentToolResult({ ...base, card: 'text' } as AnyTool, {}, 'fait')).toEqual({
      card: 'text',
      text: 'fait',
    });
    const p = presentToolResult(
      { ...base, card: 'text' } as AnyTool,
      {},
      { ok: true, message: 'm' },
    );
    expect(p.card).toBe('text');
    expect(p.card === 'text' && p.text).toContain('"message": "m"');
  });

  it('carte generic : rien à porter — entrée et sortie sont déjà sur la ligne', () => {
    expect(presentToolResult(base as AnyTool, { a: 1 }, { b: 2 })).toEqual({ card: 'generic' });
  });

  it('un présentateur qui rend une AUTRE carte que la déclarée est refusé', () => {
    const menteur = {
      ...base,
      card: 'files',
      present: () => ({
        card: 'terminal',
        command: 'ls',
        exitCode: 0,
        timedOut: false,
        stdoutTail: '',
        stderrTail: '',
      }),
    } as AnyTool;
    expect(() => presentToolResult(menteur, {}, {})).toThrow(ToolPresentationError);
    expect(() => presentToolResult(menteur, {}, {})).toThrow(/returned card "terminal"/);
  });

  it('un présentateur dont la charge utile ne respecte pas la forme est refusé, en nommant le champ', () => {
    const bancal = {
      ...base,
      card: 'table',
      present: () => ({ card: 'table', tables: [] }), // min(1)
    } as AnyTool;
    expect(() => presentToolResult(bancal, {}, {})).toThrow(ToolPresentationError);
    expect(() => presentToolResult(bancal, {}, {})).toThrow(/tables/);
  });

  it('un présentateur peut rendre text pour un ÉCHEC — la ligne garde la carte déclarée', () => {
    const files = {
      ...base,
      card: 'files',
      present: ({ output }: { output: unknown }) => ({
        card: 'text',
        text: `rien écrit : ${String((output as { reason: string }).reason)}`,
      }),
    } as AnyTool;
    expect(presentToolResult(files, {}, { ok: false, reason: 'lecture seule' })).toEqual({
      card: 'text',
      text: 'rien écrit : lecture seule',
    });
    expect(cardForTool(files)).toBe('files');
  });
});
