// gate.test.ts — la MÉCANIQUE du harnais, contre un gate factice.
//
// Les contrats du vrai gate vivent dans packages/tools, qui possède
// `executeTool`. Ici on prouve que le harnais rapporte fidèlement : qu'il
// distingue « exécuté » de « succès rapporté », qu'il couvre bien les quatre
// modes, et que ses messages d'échec nomment le mode fautif. Un harnais qui se
// trompe rend tous les tests qu'il porte sans valeur.

import { describe, it, expect } from 'vitest';
import {
  createGateHarness,
  anMcpTool,
  aBuiltinTool,
  ALL_AUTONOMIES,
  autonomyLabel,
  type ExecuteToolFn,
} from '../index';

/** Gate factice : applique la règle exacte, sinon `defaultApproval`, sinon exécute. */
const fakeGate: ExecuteToolFn = async (tool, input, ctx, opts) => {
  const rule = opts.approvalRules.find((r) => r.toolName === tool.name);
  const action = rule?.action ?? tool.defaultApproval;
  if (action === 'block') return { outcome: 'error', error: 'blocked' };
  if (action === 'require_approval' && opts.autonomy !== 'fully_autonomous') {
    await opts.onApprovalRequired({ toolName: tool.name });
    return { outcome: 'awaiting_approval', approvalRequestId: 'x' };
  }
  const output = await tool.execute(input, ctx);
  return { outcome: 'success', output };
};

const { expectGate } = createGateHarness(fakeGate);

describe('le harnais rapporte fidèlement', () => {
  it('distingue « exécuté » de « succès rapporté »', async () => {
    const [r] = await expectGate(aBuiltinTool()).withRules([]).underAutonomy(undefined).run();
    expect(r?.outcome).toBe('success');
    expect(r?.ran).toBe(true);
  });

  it('détecte un succès SANS exécution — le faux positif classique', async () => {
    // Un gate qui rapporte success sans appeler l'outil doit échouer l'attente,
    // pas la satisfaire.
    const menteur: ExecuteToolFn = async () => ({ outcome: 'success', output: {} });
    const { expectGate: g } = createGateHarness(menteur);
    await expect(
      g(aBuiltinTool()).withRules([]).underAutonomy(undefined).toRunWithoutAsking(),
    ).rejects.toThrow(/sans exécution/);
  });

  it('détecte une suspension SANS demande à un humain', async () => {
    const muet: ExecuteToolFn = async () => ({
      outcome: 'awaiting_approval',
      approvalRequestId: 'x',
    });
    const { expectGate: g } = createGateHarness(muet);
    await expect(
      g(anMcpTool()).withRules([]).underAutonomy(undefined).toRequireApproval(),
    ).rejects.toThrow(/sans jamais demander/);
  });

  it('rapporte le nom d’outil réellement soumis', async () => {
    const [r] = await expectGate(anMcpTool({ serverPrefix: 'veille', toolName: 'purge' }))
      .withRules([])
      .underAutonomy(undefined)
      .run();
    expect(r?.request?.toolName).toBe('veille__purge');
  });

  it('underEveryAutonomy couvre les quatre modes, défaut compris', async () => {
    const results = await expectGate(aBuiltinTool()).withRules([]).underEveryAutonomy().run();
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.autonomy)).toEqual([...ALL_AUTONOMIES]);
  });

  it('nomme le mode fautif dans le message d’échec', async () => {
    await expect(
      expectGate(aBuiltinTool()).withRules([]).underAutonomy('propose_confirm').toRequireApproval(),
    ).rejects.toThrow(/propose_confirm/);
  });

  it('autonomyLabel nomme le défaut livré plutôt que « undefined »', () => {
    expect(autonomyLabel(undefined)).toContain('défaut');
    expect(autonomyLabel('destructive_gate')).toBe('destructive_gate');
  });
});

describe('les builders', () => {
  it('anMcpTool porte le marqueur de namespace et se gate', () => {
    const { tool } = anMcpTool({ serverPrefix: 'veille', toolName: 'get' });
    expect(tool.name).toBe('veille__get');
    expect(tool.defaultApproval).toBe('require_approval');
  });

  it('aBuiltinTool ne déclare aucune posture — le défaut historique', () => {
    expect(aBuiltinTool().tool.defaultApproval).toBeUndefined();
  });

  it('un override ne fuit pas d’un builder à l’autre', () => {
    anMcpTool({ serverPrefix: 'x' });
    expect(anMcpTool().tool.name).toBe('srv__do_thing');
  });
});
