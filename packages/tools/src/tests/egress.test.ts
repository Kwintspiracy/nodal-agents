// egress.test.ts — chaque outil du PRODUIT dit ce qu'il atteint hors de Nodal.
//
// `egress` est une déclaration, comme `riskLevel` : aucun scanner ne prouve ce
// qu'une fonction contacte. Ce test rend la déclaration obligatoire pour tout
// outil que le produit livre (le registre et les outils de capacité que le
// runner instancie par job) : un outil intégré ajouté sans elle fait rougir
// ce test au lieu de passer, en silence, pour un outil purement local. C'est
// ce que lit le contrôle d'avant essai de l'espace du banc pour dire ce qu'il
// ne couvre pas (packages/bench/src/space/guard.ts).

import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
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
  DELIVERY_TOOL_NAMES,
} from '../communication';
import type { ToolDefinition } from '../types';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

const registry = createToolRegistry();
registerBuiltins(registry);

const capabilityTools = [
  createTelegramSendMessageTool(),
  createSendImageTool(),
  createSendFileTool(),
  createSendVideoTool(),
  createSendAudioTool(),
  createSendVoiceTool(),
  createListConversationsTool(),
] as unknown as AnyTool[];

const productTools: AnyTool[] = [...registry.list(), ...capabilityTools];

describe('egress — what a product tool reaches beyond Nodal @cap:assigner-outils/moteur', () => {
  it('every product tool declares it', () => {
    const undeclared = productTools.filter((t) => t.egress === undefined).map((t) => t.name);
    expect(undeclared).toEqual([]);
  });

  it('the delivery tools, and only they, reach a channel', () => {
    const channel = productTools.filter((t) => t.egress === 'channel').map((t) => t.name);
    expect(channel.sort()).toEqual([...DELIVERY_TOOL_NAMES].sort());
  });

  it('the tools that reach the network on their own, beyond a channel', () => {
    // A change here is a decision about what the bench check says it does not
    // cover: it is read, not updated by reflex.
    const reach = Object.fromEntries(
      productTools
        .filter((t) => t.egress !== 'none' && t.egress !== 'channel')
        .map((t) => [t.name, t.egress])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    expect(reach).toEqual({
      code_task: 'process',
      generate_speech: 'model-provider',
      run_command: 'process',
      run_skill_script: 'process',
      save_memory: 'model-provider',
      web_search: 'internet',
    });
  });
});
