// gate — the approval decision matrix, measured against the REAL executeTool.
//
// This section exists because of what happened on 2026-08-07 and 08-08: a
// one-line change made every MCP tool "heavy", which silently redefined the
// owner's `destructive_gate` setting; and the dashboard's "always allow" button
// wrote nothing because `auto_approve` still meant "delete the rule". Both
// passed the whole suite. Neither was visible as a NUMBER until someone
// counted decisions.
//
// So: run a fixed grid of (tool × rules × autonomy) through the production gate
// and count outcomes. The counts are the metric. Any flip shows up as a diff
// with the exact scenario named.

import {
  createGateHarness,
  anMcpTool,
  aBuiltinTool,
  aGatedBuiltinTool,
} from '@nodal-agents/test-kit';
import type { ExecuteToolFn } from '@nodal-agents/test-kit';
import { executeTool } from '@nodal-agents/tools';
import type { Metric, Section } from '../types';

const AUTONOMIES = [undefined, 'propose_confirm', 'destructive_gate', 'fully_autonomous'] as const;

interface Scenario {
  id: string;
  build: () => ReturnType<typeof anMcpTool>;
  input?: unknown;
}

/**
 * The grid. Deliberately small and NAMED: the point is not coverage (the suite
 * does that) but a stable set of decisions whose movement is meaningful.
 */
const SCENARIOS: Scenario[] = [
  { id: 'mcp_ordinaire', build: () => anMcpTool() },
  { id: 'mcp_declare_destructeur', build: () => anMcpTool({ riskLevel: 'destructive' }) },
  { id: 'builtin_lecture', build: () => aBuiltinTool() },
  {
    id: 'run_command_anodin',
    build: () => aGatedBuiltinTool(),
    input: { command: 'echo hi', purpose: 'bench' },
  },
  {
    id: 'run_command_destructeur',
    build: () => aGatedBuiltinTool(),
    input: { command: 'rm -rf /tmp/x', purpose: 'bench' },
  },
];

export const gateSection: Section = {
  id: 'gate',
  label: 'Matrice de décision du gate',
  why: 'Une décision qui bascule en silence, c’est soit une action non gardée, soit un réglage d’autonomie qui ne veut plus rien dire.',
  tests: [
    '@nodal-agents/tools:src/tests/mcp-approval-gate.test.ts',
    '@nodal-agents/tools:src/tests/execute.test.ts',
  ],

  async run(): Promise<Metric[]> {
    const { expectGate } = createGateHarness(executeTool as unknown as ExecuteToolFn);
    let asked = 0;
    let ran = 0;
    let blocked = 0;
    const decisions: string[] = [];

    for (const s of SCENARIOS) {
      for (const autonomy of AUTONOMIES) {
        const built = s.build();
        let chain = expectGate(built).withRules([]).underAutonomy(autonomy);
        if (s.input !== undefined) chain = chain.withInput(s.input);
        const [r] = await chain.run();
        if (!r) continue;
        const label = autonomy ?? 'défaut';
        if (r.outcome === 'awaiting_approval') {
          asked++;
          decisions.push(`${s.id}@${label} → demande`);
        } else if (r.outcome === 'error') {
          blocked++;
          decisions.push(`${s.id}@${label} → refus`);
        } else {
          ran++;
          decisions.push(`${s.id}@${label} → passe`);
        }
      }
    }

    return [
      {
        id: 'decisions_total',
        label: 'Décisions mesurées',
        value: SCENARIOS.length * AUTONOMIES.length,
        unit: 'décisions',
        direction: 'exact',
      },
      {
        id: 'asks_human',
        label: 'Suspend pour approbation',
        value: asked,
        unit: 'décisions',
        // `exact`: this number moving in EITHER direction is the story. Fewer
        // asks can mean an action lost its gate; more can mean an autonomy
        // setting stopped being honoured. Both are regressions until reviewed.
        direction: 'exact',
        detail: decisions.filter((d) => d.endsWith('demande')),
      },
      {
        id: 'runs_freely',
        label: 'Passe sans demander',
        value: ran,
        unit: 'décisions',
        direction: 'exact',
        detail: decisions.filter((d) => d.endsWith('passe')),
      },
      {
        id: 'blocked',
        label: 'Refusé d’emblée',
        value: blocked,
        unit: 'décisions',
        direction: 'exact',
      },
    ];
  },
};
