// AutonomyTabCopy.test.tsx : les textes de l'onglet Approvals (issue #382).
//
// Ce que ça prouve, sur le DOM rendu : chaque phrase de la table « Screen copy »
// de l'issue est bien À L'ÉCRAN, et l'onglet montre `label`/`summary` des outils
// natifs, jamais leur `description`. Les textes sont ceux de Quentin, relus
// contre le code ; ce fichier est ce qui empêche une reformulation silencieuse.
//
// L'onglet est rendu en entier, avec ses sections filles, parce que la copie
// est répartie entre elles : une assertion par section prouverait chaque bout
// sans prouver que le propriétaire les lit ensemble.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Rule = { id: string; toolName: string; action: string };
type InternalTool = {
  slug: string;
  label: string;
  summary: string;
  risk: 'read' | 'write' | 'destructive';
  unblockableReason?: string;
};

const INTERNAL_TOOLS: InternalTool[] = [
  {
    slug: 'file_write',
    label: 'Write a workspace file',
    summary:
      'Create or replace a file safely. For a small change to an existing file, use Edit a workspace file. Maximum write size: 1 MiB.',
    risk: 'write',
  },
  {
    slug: 'return_result',
    label: 'Finish a task',
    summary:
      'Report that a task succeeded or is blocked. It sends no answer by itself: the agent delivers its answer in the same step, through the right channel.',
    risk: 'write',
    unblockableReason:
      'Always available. The agent needs this tool to finish a job or explain why it is stuck. ' +
      'It cannot be blocked.',
  },
];

const actions = vi.hoisted(() => {
  const noop = () => vi.fn(async () => ({ ok: true as const, data: undefined }));
  return {
    listAgentApprovalRulesAction: vi.fn(async () => ({ ok: true as const, data: [] as Rule[] })),
    listInternalToolsAction: vi.fn(async () => ({ ok: true as const, data: [] as InternalTool[] })),
    setAgentApprovalRuleAction: noop(),
    setRunCommandYoloAction: noop(),
    setCodeTaskYoloAction: noop(),
    setCliDailyBudgetAction: noop(),
    getCliUsageTodayAction: vi.fn(async () => ({ ok: true as const, data: { usd: 0 } })),
    setCliDefaultsAction: noop(),
    setReviewerReadOnlyPresetAction: noop(),
    setAgentRuntimeAction: noop(),
    setCliRuntimeModeAction: noop(),
    setSkillScriptsAuthorizedAction: noop(),
    setSkillFilesWritableAction: noop(),
    setAgentCommandAllowlistAction: noop(),
    setAgentMayChangeTeamAction: noop(),
    assignSkillAction: noop(),
    unassignSkillAction: noop(),
    updateAgentAction: noop(),
    deleteAgentAction: noop(),
    listAgentWorkspacesAction: noop(),
    setWorkspaceHiddenFromCodeAction: noop(),
    listKeyModelsAction: noop(),
    addAgentWorkspaceAction: noop(),
    removeAgentWorkspaceAction: noop(),
    uploadToWorkspaceAction: noop(),
    listWorkspaceFilesAction: noop(),
    deleteWorkspaceFileAction: noop(),
  };
});

vi.mock('@/lib/actions.ts', () => actions);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { AutonomyTab } = await import('../AgentComposer.tsx');

const AGENT_ID = '33333333-3333-4333-8333-333333333333';

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AutonomyTab
        agentId={AGENT_ID}
        connectors={[]}
        mcpServers={[]}
        hasTelegramBot={false}
        attachedSkills={[
          {
            id: 'skill-1',
            slug: 'command-execution',
            name: 'Run commands',
            description: null,
            assigned: true,
          } as never,
        ]}
        autoRunPaused={false}
        isOwner
        cliDailyBudgetUsd={0}
        commandAllowlist={null}
        mayChangeTeam={false}
      />,
    );
  });
  // Les deux chargements (règles, outils natifs) se résolvent après le montage.
  await act(async () => {});
  return container.textContent ?? '';
}

beforeEach(() => {
  actions.listAgentApprovalRulesAction.mockImplementation(async () => ({
    ok: true as const,
    data: [],
  }));
  actions.listInternalToolsAction.mockImplementation(async () => ({
    ok: true as const,
    data: INTERNAL_TOOLS,
  }));
});

describe("les textes de l'onglet Approvals @cap:regler-autonomie/ecran", () => {
  it('ouvre sur ce que le propriétaire décide ici', async () => {
    const text = await render();
    expect(text).toContain(
      'Choose what this agent can do on its own, what needs your approval, and what it cannot do. Set a rule for each external tool. Built-in tools are listed below.',
    );
  });

  it('dit la règle par défaut et quand un changement prend effet', async () => {
    const text = await render();
    expect(text).toContain(
      'Connector tools without a rule run without asking. Third-party tools, commands and the tools that change your workspace ask first.',
    );
    expect(text).toContain("Changes apply at the agent's next step.");
  });

  it('dit ce que devient un outil bloqué', async () => {
    const text = await render();
    expect(text).toContain(
      'Blocked tools stay visible to the agent. If it tries to use one, it is told the tool is blocked.',
    );
  });

  it('présente les outils natifs, et les rend par label et summary', async () => {
    const text = await render();
    expect(text).toContain(
      'Every agent has these tools. Set which ones this agent may use, including memory, web search, and workspace files.',
    );
    expect(text).toContain('Write a workspace file');
    expect(text).toContain('Create or replace a file safely.');
    expect(text).toContain('file_write');
  });

  it('dit pourquoi return_result ne se bloque pas', async () => {
    const text = await render();
    expect(text).toContain(
      'Always available. The agent needs this tool to finish a job or explain why it is stuck. It cannot be blocked.',
    );
  });

  it('porte les trois décisions du curseur', async () => {
    const text = await render();
    expect(text).toContain('Run without asking');
    expect(text).toContain('Ask for approval');
    expect(text).toContain('Block');
    // Les anciens mots ont disparu de l'écran, pas seulement été doublés.
    expect(text).not.toContain('Autonomous');
    expect(text).not.toContain('Ask first');
  });

  it('dit ce que sont les commandes, et la liste qui les borne', async () => {
    const text = await render();
    expect(text).toContain('Commands ask for your approval by default.');
    expect(text).toContain('Run commands without asking');
    expect(text).toContain(
      'When on, the agent can run any permitted command immediately. Commands are still logged. Use this only for agents you trust.',
    );
    expect(text).toContain('Allowed commands');
    expect(text).toContain('Leave the list empty to allow any command.');
    expect(text).toContain(
      'Add one command prefix per line, such as node or npx vitest. Each entry allows that program and its arguments. With a list, commands run without a shell: no chaining, no redirection. Clear the list and save to remove the limit.',
    );
    expect(text).toContain('Block all commands');
    expect(text).toContain(
      'This list applies only to run_command. Skill scripts, Code tasks, and verification commands are unaffected.',
    );
  });

  it("dit ce que l'agent peut faire de son équipe, et ce qu'être en lecture seule veut dire", async () => {
    const text = await render();
    expect(text).toContain('Let this agent change its team');
    expect(text).toContain(
      'Allow the agent to create, attach, or detach agents during a run. When off, it must work with the team you assigned and tell you if it needs someone else.',
    );
    expect(text).toContain('Read-only agent');
    expect(text).toContain(
      'Prevent this agent from writing files, editing skill files, running commands, or running skill scripts. You can turn this off at any time.',
    );
  });
});
