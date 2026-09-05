// cards.test.ts — tout outil que le PRODUIT expédie déclare comment son
// résultat se montre (plan « De la maquette au produit », P1).
//
// Pourquoi par ÉNUMÉRATION du registre et non par liste : une liste écrite à
// la main vieillit en silence (voir intent-wiring.test.ts, même leçon). Ici les
// outils sont DÉCOUVERTS — un outil ajouté demain sans `card` fait rougir ce
// fichier en se nommant, sans qu'aucune liste n'ait à être tenue.
//
// Ce que ce test NE couvre PAS, et le dit : les outils tiers (serveurs MCP,
// adaptateurs de connecteurs) ont droit au repli `generic`. Le seul outil MCP
// est construit par une fabrique qui le déclare ; les adaptateurs restent sur
// le repli, et la seconde suite ci-dessous vérifie que ce repli est bien
// `generic` et rien d'autre.

import { describe, it, expect } from 'vitest';
import { TOOL_CARDS } from '@nodal-agents/shared';
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
import { cardForTool, declaresCard, TOOL_CARD_GENERIC } from '../cards';
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

  it('les cartes déclarées couvrent le vocabulaire utile, pas une seule valeur passe-partout', () => {
    // Si tout déclarait `text`, le contrat serait respecté à la lettre et
    // inutile en pratique : l'écran n'aurait rien à dispatcher.
    const utilisees = new Set([...registry.list(), ...capabilityTools].map((t) => cardForTool(t)));
    for (const attendue of [
      'text',
      'read',
      'search',
      'files',
      'table',
      'terminal',
      'sent',
      'checks',
    ]) {
      expect(
        utilisees.has(attendue as (typeof TOOL_CARDS)[number]),
        `aucun outil ne déclare '${attendue}'`,
      ).toBe(true);
    }
    // Et aucun outil du produit ne se repose sur le repli.
    expect(utilisees.has(TOOL_CARD_GENERIC)).toBe(false);
  });

  it('les cartes que chaque famille déclare sont celles que l’écran attend', () => {
    // Quelques ancres nommées : si quelqu'un requalifie `run_command` en `text`,
    // la carte terminal disparaît de l'écran sans que rien ne casse ailleurs.
    const carte = (name: string) => cardForTool(registry.get(name) as AnyTool);
    expect(carte('run_command')).toBe('terminal');
    expect(carte('run_skill_script')).toBe('terminal');
    expect(carte('file_write')).toBe('files');
    expect(carte('code_task')).toBe('files');
    expect(carte('file_read')).toBe('read');
    expect(carte('web_search')).toBe('search');
    expect(carte('xlsx_read')).toBe('table');
    expect(carte('review_verdict')).toBe('checks');
    expect(carte('return_result')).toBe('text');
    expect(carte('dashboard_publish')).toBe('sent');
  });
});

describe('cardForTool — le repli est `generic`, et seulement lui', () => {
  const base = {
    name: 'tiers',
    description: 'outil tiers',
    inputSchema: {} as z.ZodTypeAny,
    riskLevel: 'read' as const,
    execute: async () => null,
  };

  it('un outil sans carte rend generic — l’aveu, pas une devinette', () => {
    expect(cardForTool(base as AnyTool)).toBe('generic');
    expect(declaresCard(base as AnyTool)).toBe(false);
  });

  it('une carte hors du vocabulaire est traitée comme absente', () => {
    // Un outil tiers qui inventerait `'fancy'` ne peut être dispatché par aucun
    // écran : la dire `generic` est plus vrai que de la laisser passer.
    const tordu = { ...base, card: 'fancy' } as unknown as AnyTool;
    expect(cardForTool(tordu)).toBe('generic');
    expect(declaresCard(tordu)).toBe(false);
  });

  it('une carte déclarée dans le vocabulaire est rendue telle quelle', () => {
    for (const c of TOOL_CARDS) {
      expect(cardForTool({ ...base, card: c } as AnyTool)).toBe(c);
    }
  });
});
