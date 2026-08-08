// mcp-approval-gate.test.ts — les contrats du VRAI gate, écrits avec le kit.
//
// MCP-001 : avant le correctif, un outil venu d'un serveur MCP tiers ne
// déclarait aucun `defaultApproval`, donc `executeTool` tombait sur
// `matchedRule?.action ?? tool.defaultApproval` → `undefined` et l'exécutait.
// Mesuré contre le gate réel : `execute()` appelé et aucune approbation demandée
// dans LES QUATRE modes d'autonomie, y compris le défaut livré.
//
// Chaque contrat tient en une ligne parce que le harnais porte la plomberie
// (@nodal-agents/test-kit). Ce n'est pas cosmétique : la version manuelle de ce
// fichier faisait 200 lignes, et c'est ce coût qui fait qu'on écrit « les modes
// qui comptent » au lieu des quatre — la forme exacte qu'a prise le trou É-2,
// gaté sous `destructive_gate` et absent en `fully_autonomous`.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  createGateHarness,
  anMcpTool,
  aBuiltinTool,
  aGatedBuiltinTool,
  aServerRule,
  aToolRule,
  TEST_AGENT_ID,
  type ExecuteToolFn,
} from '@nodal-agents/test-kit';
import { executeTool } from '../execute';

// Branché sur le gate de production. Si `executeTool` change, ces tests bougent.
const { expectGate } = createGateHarness(executeTool as unknown as ExecuteToolFn);

describe('MCP-001 — un outil MCP tiers est gaté sans règle', () => {
  it('suspend pour approbation dans les trois modes non-yolo', async () => {
    await expectGate(anMcpTool())
      .withRules([])
      .underAutonomy(undefined, 'propose_confirm', 'destructive_gate')
      .toRequireApproval();
  });

  it('honore fully_autonomous — le propriétaire a renoncé aux demandes', async () => {
    await expectGate(anMcpTool())
      .withRules([])
      .underAutonomy('fully_autonomous')
      .toRunWithoutAsking();
  });

  it('un readOnlyHint auto-déclaré ne peut pas abaisser la posture', async () => {
    // Le serveur prétendait « lecture seule » et obtenait riskLevel 'read',
    // ce qui le faisait auto-approuver sous destructive_gate.
    await expectGate(anMcpTool({ riskLevel: 'read' }))
      .withRules([])
      .underAutonomy('destructive_gate')
      .toRequireApproval();
  });

  it('CONTRE-ÉPREUVE : un outil ordinaire du produit s’exécute sans demande', async () => {
    // Prouve que les suspensions viennent de `defaultApproval`, pas d'un gate
    // qui refuserait tout. Sans elle, un gate cassé « passerait » tout ce qui
    // précède.
    await expectGate(aBuiltinTool()).withRules([]).underEveryAutonomy().toRunWithoutAsking();
  });
});

describe('Règles par SERVEUR — un consentement, pas trente', () => {
  it('un auto_approve par serveur couvre tous ses outils', async () => {
    await expectGate(anMcpTool({ serverPrefix: 'veille', toolName: 'get_status' }))
      .withRules([aServerRule('veille')])
      .underAutonomy(undefined)
      .toRunWithoutAsking();
  });

  it('ne déborde pas sur un autre serveur', async () => {
    await expectGate(anMcpTool({ serverPrefix: 'autre', toolName: 'get_status' }))
      .withRules([aServerRule('veille')])
      .underAutonomy(undefined)
      .toRequireApproval();
  });

  it('une règle par outil l’emporte sur la règle par serveur', async () => {
    // « Ce serveur oui, SAUF cet outil » doit rester exprimable.
    await expectGate(anMcpTool({ serverPrefix: 'veille', toolName: 'purge' }))
      .withRules([aServerRule('veille'), aToolRule('veille__purge', 'require_approval')])
      .underAutonomy(undefined)
      .toRequireApproval();
  });

  it('un block par serveur refuse même en fully_autonomous', async () => {
    await expectGate(anMcpTool({ serverPrefix: 'veille' }))
      .withRules([aServerRule('veille', 'block')])
      .underEveryAutonomy()
      .toBeBlocked();
  });

  it('ne peut jamais relâcher un outil du produit — les builtins n’ont pas de namespace', async () => {
    await expectGate(aGatedBuiltinTool())
      .withRules([aServerRule('run')])
      .withInput({ command: 'echo hi' })
      .underAutonomy(undefined)
      .toRequireApproval();
  });

  it('un consentement explicite par outil fait passer sans demande', async () => {
    await expectGate(anMcpTool({ serverPrefix: 'veille', toolName: 'get_status' }))
      .withRules([aToolRule('veille__get_status')])
      .underAutonomy(undefined)
      .toRunWithoutAsking();
  });
});

describe('create_mcp stdio — plancher dur dans tous les modes', () => {
  const createMcp = () =>
    aGatedBuiltinTool({
      name: 'create_mcp',
      description: 'Register an MCP server.',
      riskLevel: 'write',
      inputSchema: z.object({ transport: z.string().optional() }),
    });

  it('exige un humain dans les quatre modes', async () => {
    // É-2 l'avait gaté sous destructive_gate ; le trou était fully_autonomous,
    // qui auto-approuve AVANT d'atteindre cette branche.
    await expectGate(createMcp())
      .withRules([])
      .withInput({ transport: 'stdio' })
      .underEveryAutonomy()
      .toRequireApproval();
  });

  it('résiste même à une règle auto_approve explicite', async () => {
    await expectGate(createMcp())
      .withRules([aToolRule('create_mcp')])
      .withInput({ transport: 'stdio' })
      .underAutonomy('fully_autonomous')
      .toRequireApproval();
  });

  it('laisse le transport http sur le chemin É-2 existant', async () => {
    // Délibérément NON floored : http ne lance aucun sous-processus, et chaque
    // outil du serveur attaché porte désormais son propre gate (MCP-001).
    const results = await expectGate(createMcp())
      .withRules([])
      .withInput({ transport: 'http' })
      .underAutonomy('destructive_gate')
      .run();
    expect(results[0]?.outcome).toBe('success');
  });
});

describe('Portée des règles — cet agent, ou tout l’espace de travail', () => {
  it('une règle par serveur à portée espace de travail couvre chaque agent', async () => {
    // Le choix « pour tous mes agents » : agent_id IS NULL. Avec sept serveurs,
    // la portée par agent transforme une décision en dizaines de clics
    // identiques — et c'est ainsi qu'on finit par poser une règle `*`.
    await expectGate(anMcpTool({ serverPrefix: 'veille' }))
      .withRules([aServerRule('veille', 'auto_approve', { agentId: null })])
      .underAutonomy(undefined)
      .toRunWithoutAsking();
  });

  it('une règle d’agent l’emporte sur la règle d’espace de travail', async () => {
    // Un `require_approval` posé sur CET agent doit survivre à une confiance
    // accordée à l'échelle de l'espace — sinon le réglage fin devient un
    // mensonge dès qu'on élargit une fois.
    await expectGate(anMcpTool({ serverPrefix: 'veille' }))
      .withRules([
        aServerRule('veille', 'auto_approve', { agentId: null }),
        aServerRule('veille', 'require_approval', { agentId: TEST_AGENT_ID }),
      ])
      .underAutonomy(undefined)
      .toRequireApproval();
  });
});
