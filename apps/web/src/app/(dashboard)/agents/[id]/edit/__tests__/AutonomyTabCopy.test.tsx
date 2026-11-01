// AutonomyTabCopy.test.tsx : ce que l'onglet Autonomie MONTRE (issues #382,
// #361, #917).
//
// Depuis #917 chaque ligne de l'onglet est une ligne en base : celle que la
// porte applique. Ce fichier prouve, sur le DOM rendu, que l'écran montre la
// valeur de la ligne et rien d'autre (aucune valeur calculée pour un outil qui
// n'en a pas), que chaque geste envoie la ligne qu'il écrit, et que les textes
// de Quentin sont à l'écran.
//
// L'onglet est rendu en entier, avec ses sections filles, parce que la copie
// est répartie entre elles.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Rule = {
  id: string;
  toolName: string;
  action: string;
  conditionJson: { workspacePath?: string } | null;
  workspaceLabel: string | null;
};
type InternalTool = {
  slug: string;
  label: string;
  summary: string;
  risk: 'read' | 'write' | 'destructive';
  unblockableReason?: string;
};
type HeldTool = {
  name: string;
  label: string;
  summary: string;
  risk: 'read' | 'write' | 'destructive';
  source: 'builtin' | 'delivery' | 'connector' | 'mcp' | 'delegation';
};

const SETTING = 'setting:replace_shared_file';

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

const HELD_TOOLS: HeldTool[] = [
  {
    name: 'file_write',
    label: 'Write a workspace file',
    summary: '',
    risk: 'write',
    source: 'builtin',
  },
  { name: 'return_result', label: 'Finish a task', summary: '', risk: 'write', source: 'builtin' },
  {
    name: 'run_command',
    label: 'Run a command',
    summary: '',
    risk: 'destructive',
    source: 'builtin',
  },
  {
    name: 'create_mcp',
    label: 'Add an MCP server',
    summary: 'Connect a new MCP server to the workspace.',
    risk: 'write',
    source: 'builtin',
  },
  { name: 'cogni_cortex__read_page', label: 'read_page', summary: '', risk: 'read', source: 'mcp' },
];

const actions = vi.hoisted(() => {
  const noop = () => vi.fn(async () => ({ ok: true as const, data: undefined }));
  return {
    listAgentApprovalRulesAction: vi.fn(async () => ({ ok: true as const, data: [] as Rule[] })),
    listInternalToolsAction: vi.fn(async () => ({ ok: true as const, data: [] as InternalTool[] })),
    listAgentAutonomyToolsAction: vi.fn(async () => ({
      ok: true as const,
      data: { tools: [] as HeldTool[], sharedFileSetting: true },
    })),
    // Typée avec son argument : les assertions portent sur CE QUI EST ENVOYÉ
    // au serveur, pas sur un compteur d'appels (invariant #5).
    setAgentApprovalRuleAction: vi.fn(
      async (_raw: {
        agentId: string;
        toolName: string;
        action: string | null;
        workspacePath?: string;
      }): Promise<
        { ok: true; data: undefined } | { ok: false; code: string; message: string }
      > => ({ ok: true, data: undefined }),
    ),
    setRunCommandRuleAction: vi.fn(
      async (_raw: {
        agentId: string;
        action: 'auto_approve' | 'require_approval' | 'block';
      }): Promise<
        { ok: true; data: undefined } | { ok: false; code: string; message: string }
      > => ({
        ok: true,
        data: undefined,
      }),
    ),
    setCodeTaskYoloAction: noop(),
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

const CONNECTOR = {
  connectorId: 'c1',
  slug: 'cloudflare',
  label: 'Cloudflare',
  credentialName: null,
  assigned: true,
  enabledOperations: null,
  availableOperations: [
    {
      slug: 'cloudflare_deploy',
      name: 'Deploy to Workers',
      label: 'Publish to Cloudflare Workers',
      summary:
        'Publish a built site or app from the workspace. It goes live at a workers.dev address.',
      risk: 'write' as const,
      requiresApproval: true,
      description:
        'Publish a built static site/app directory from the agent workspace to Cloudflare Workers.',
    },
    {
      slug: 'legacy_write',
      name: 'Legacy operation',
      risk: 'write' as const,
      requiresApproval: true,
      description: 'What this connector has always shown, for an adapter not yet rewritten.',
    },
  ],
};

const MCP_SERVER = {
  mcpServerId: 'm1',
  slug: 'cogni-cortex',
  label: 'Cogni Cortex',
  assigned: true,
  enabledTools: null,
  availableTools: [
    { name: 'read_page', description: 'Read one page.' },
    { name: 'run_code_unsafe', description: 'Run arbitrary code in the browser.' },
  ],
};

const row = (
  toolName: string,
  action: 'auto_approve' | 'require_approval' | 'block',
  folder?: { path: string; label: string },
): Rule => ({
  id: `r-${toolName}-${folder?.label ?? ''}`,
  toolName,
  action,
  conditionJson: folder ? { workspacePath: folder.path } : null,
  workspaceLabel: folder?.label ?? null,
});

async function render(
  connectors: unknown[] = [],
  rules: Rule[] = [],
  mcpServers: unknown[] = [],
  opts: { skills?: string[]; tools?: HeldTool[]; sharedFileSetting?: boolean } = {},
): Promise<string> {
  actions.listAgentApprovalRulesAction.mockImplementation(async () => ({
    ok: true as const,
    data: rules,
  }));
  actions.listAgentAutonomyToolsAction.mockImplementation(async () => ({
    ok: true as const,
    data: { tools: opts.tools ?? HELD_TOOLS, sharedFileSetting: opts.sharedFileSetting ?? true },
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AutonomyTab
        agentId={AGENT_ID}
        connectors={connectors as never}
        mcpServers={mcpServers as never}
        hasTelegramBot={false}
        attachedSkills={(opts.skills ?? ['command-execution']).map(
          (slug) =>
            ({
              id: `skill-${slug}`,
              slug,
              name: slug,
              description: null,
              assigned: true,
            }) as never,
        )}
        autoRunPaused={false}
        isOwner
        commandAllowlist={null}
        mayChangeTeam={false}
        shellPolicy={null}
      />,
    );
  });
  await act(async () => {});
  return container.textContent ?? '';
}

function control(slug: string, action: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    `[data-testid="autonomy-btn-${slug}-${action}"]`,
  );
  if (!el) throw new Error(`no control for ${slug} ${action}`);
  return el;
}

const pressed = (slug: string) =>
  ['auto_approve', 'require_approval', 'block'].filter(
    (a) => control(slug, a).getAttribute('aria-pressed') === 'true',
  );

// Le corps du document est PARTAGÉ : la boîte de confirmation sort par un
// portail, et un rendu laissé en place ferait lire à l'assertion suivante un
// dialogue ouvert par le test d'avant.
afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

beforeEach(() => {
  actions.setAgentApprovalRuleAction.mockReset();
  actions.setAgentApprovalRuleAction.mockImplementation(async () => ({
    ok: true,
    data: undefined,
  }));
  actions.listInternalToolsAction.mockImplementation(async () => ({
    ok: true as const,
    data: INTERNAL_TOOLS,
  }));
});

describe('every row shows the value stored for this agent, and nothing else (#917) @cap:regler-autonomie/ecran', () => {
  it('a connector operation shows ITS row, whatever the operation asks by default', async () => {
    await render(
      [CONNECTOR],
      [row('cloudflare_deploy', 'auto_approve'), row('legacy_write', 'block')],
    );
    // `requiresApproval: true` on both: the row decides what is shown.
    expect(pressed('cloudflare_deploy')).toEqual(['auto_approve']);
    expect(pressed('legacy_write')).toEqual(['block']);
  });

  it('a tool without a row shows no choice and says it is refused: no computed default', async () => {
    await render([CONNECTOR], [row('cloudflare_deploy', 'require_approval')]);
    expect(pressed('legacy_write')).toEqual([]);
    expect(
      container.querySelector('[data-testid="autonomy-unset-legacy_write"]')?.textContent,
    ).toBe('Not set: this tool is refused until you choose.');
    // A built-in without a row: the same, never "Run without asking".
    expect(pressed('file_write')).toEqual([]);
  });

  it('a change sends the row it writes, and the row shows it', async () => {
    await render([CONNECTOR], [row('cloudflare_deploy', 'require_approval')]);
    await act(async () => {
      control('cloudflare_deploy', 'block').click();
    });
    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'cloudflare_deploy',
      action: 'block',
    });
    expect(pressed('cloudflare_deploy')).toEqual(['block']);
  });

  it('a refused write puts the row back as the server holds it', async () => {
    actions.setAgentApprovalRuleAction.mockImplementation(async () => ({
      ok: false,
      code: 'validation_failed',
      message: 'nope',
    }));
    await render([CONNECTOR], [row('cloudflare_deploy', 'require_approval')]);
    await act(async () => {
      control('cloudflare_deploy', 'auto_approve').click();
    });
    await act(async () => {});
    expect(pressed('cloudflare_deploy')).toEqual(['require_approval']);
  });

  it('relâche la ligne quand la promesse d’enregistrement rejette', async () => {
    // Revue Reviewer C, passe 4, C1 : un rejet saute tout le `then`. La ligne
    // restait grise pour toujours, sans un mot.
    actions.setAgentApprovalRuleAction.mockImplementation(async () => {
      throw new Error('network down');
    });
    await render([], [row('file_write', 'auto_approve')]);
    await act(async () => {
      control('file_write', 'block').click();
    });
    await act(async () => {});
    expect(control('file_write', 'block').disabled).toBe(false);
  });

  it("n'affiche pas les lignes de l'agent précédent quand on change d'agent", async () => {
    // Revue Reviewer C, passe 3, C1 : une lecture qui échoue laissait celles
    // d'avant à l'écran, sous le nom du nouvel agent.
    await render([], [row('file_write', 'block')]);
    expect(pressed('file_write')).toEqual(['block']);
    actions.listAgentApprovalRulesAction.mockImplementation(
      async () =>
        ({ ok: false, code: 'db_error', message: 'Failed to load approval rules' }) as never,
    );
    await act(async () => {
      root.render(
        <AutonomyTab
          agentId="44444444-4444-4444-8444-444444444444"
          connectors={[]}
          mcpServers={[]}
          hasTelegramBot={false}
          attachedSkills={[]}
          autoRunPaused={false}
          isOwner
          commandAllowlist={null}
          mayChangeTeam={false}
          shellPolicy={null}
        />,
      );
    });
    await act(async () => {});
    expect(pressed('file_write')).toEqual([]);
  });
});

describe('the shared-file setting has its own row (#917) @cap:regler-autonomie/ecran', () => {
  it('is shown beside the built-in tools, with its value, and a change sends its row', async () => {
    const text = await render([], [row(SETTING, 'require_approval')]);
    expect(text).toContain('Replace or remove a shared file this agent did not create');
    expect(text).toContain(
      'Writing over, editing, moving or removing a file in the shared folder that another run made. Applies to every file tool, whatever its own setting.',
    );
    expect(pressed(SETTING)).toEqual(['require_approval']);

    await act(async () => {
      control(SETTING, 'auto_approve').click();
    });
    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: SETTING,
      action: 'auto_approve',
    });
  });

  it('is not shown for an agent with no tool that can replace a shared file', async () => {
    await render([], [], [], { sharedFileSetting: false });
    expect(container.querySelector(`[data-testid="autonomy-btn-${SETTING}-block"]`)).toBeNull();
  });
});

describe('every tool the agent holds is on the tab (#917) @cap:regler-autonomie/ecran', () => {
  it('"Other tools" lists the ones no section names, with their row, and says what no setting lifts', async () => {
    const text = await render([], [row('create_mcp', 'auto_approve')]);
    expect(text).toContain('Other tools');
    const list = container.querySelector('[data-testid="autonomy-other-list"]');
    expect(list?.textContent).toContain('Add an MCP server');
    expect(pressed('create_mcp')).toEqual(['auto_approve']);
    expect(container.querySelector('[data-testid="autonomy-note-create_mcp"]')?.textContent).toBe(
      'A local server always asks before it starts, whatever this setting says.',
    );
    // Shown in their own section, never twice: built-ins, run_command, MCP tools.
    expect(list?.textContent).not.toContain('Write a workspace file');
    expect(list?.textContent).not.toContain('read_page');
    expect(list?.textContent).not.toContain('Run a command');
  });
});

describe('a row confined to a folder lives beside the tool row (#361, #917) @cap:regler-autonomie/ecran', () => {
  const DEV = { path: 'D:\\APPS\\Dev', label: 'Dev' };

  it('the tool row shows its own value; the folder row is said under it, with its value', async () => {
    await render([], [row('file_write', 'block'), row('file_write', 'auto_approve', DEV)]);
    expect(pressed('file_write')).toEqual(['block']);
    expect(
      container.querySelector('[data-testid="autonomy-folder-file_write"]')?.textContent,
    ).toContain('In Dev: Run without asking');
  });

  it('changing the tool row leaves the folder row alone: one write, no folder in it', async () => {
    await render([], [row('file_write', 'block'), row('file_write', 'auto_approve', DEV)]);
    await act(async () => {
      control('file_write', 'require_approval').click();
    });
    expect(actions.setAgentApprovalRuleAction.mock.calls).toEqual([
      [{ agentId: AGENT_ID, toolName: 'file_write', action: 'require_approval' }],
    ]);
    expect(
      container.querySelector('[data-testid="autonomy-folder-file_write"]')?.textContent,
    ).toContain('In Dev: Run without asking');
  });

  it('Remove deletes the folder row only, by its folder', async () => {
    await render([], [row('file_write', 'block'), row('file_write', 'auto_approve', DEV)]);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="autonomy-folder-remove-file_write"]')!
        .click();
    });
    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'file_write',
      action: null,
      workspacePath: DEV.path,
    });
  });
});

describe("les outils d'un serveur MCP, un par un @cap:regler-autonomie/ecran", () => {
  function fold(): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      '[data-testid="autonomy-mcp-fold-cogni_cortex"]',
    );
    if (!el) throw new Error('no fold for the server');
    return el;
  }

  async function open(): Promise<void> {
    await act(async () => {
      fold().click();
    });
  }

  it('annonce combien le serveur expose, et ne les montre que sur demande', async () => {
    await render([], [], [MCP_SERVER]);
    expect(fold().textContent).toContain('2 tools');
    expect(container.querySelector('[data-testid="autonomy-mcp-tools-cogni_cortex"]')).toBeNull();
    await open();
    const list = container.querySelector('[data-testid="autonomy-mcp-tools-cogni_cortex"]');
    expect(list!.textContent).toContain('read_page');
    expect(list!.textContent).toContain('Run arbitrary code in the browser.');
  });

  it('each tool shows ITS row; there is no "Follow the server" any more', async () => {
    await render(
      [],
      [
        row('cogni_cortex__*', 'auto_approve'),
        row('cogni_cortex__read_page', 'auto_approve'),
        row('cogni_cortex__run_code_unsafe', 'block'),
      ],
      [MCP_SERVER],
    );
    await open();
    expect(pressed('cogni_cortex__read_page')).toEqual(['auto_approve']);
    expect(pressed('cogni_cortex__run_code_unsafe')).toEqual(['block']);
    expect(
      container.querySelector('[data-testid="autonomy-btn-cogni_cortex__read_page-inherit"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Follow the server');
  });

  it("enregistre sur le NOM EXACT de l'outil, pas sur le motif du serveur", async () => {
    await render([], [row('cogni_cortex__run_code_unsafe', 'require_approval')], [MCP_SERVER]);
    await open();
    await act(async () => {
      control('cogni_cortex__run_code_unsafe', 'block').click();
    });
    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'cogni_cortex__run_code_unsafe',
      action: 'block',
    });
  });

  it('the server row sets every tool of the server; with a tool set apart, it asks first', async () => {
    await render(
      [],
      [
        row('cogni_cortex__*', 'require_approval'),
        row('cogni_cortex__read_page', 'require_approval'),
        row('cogni_cortex__run_code_unsafe', 'block'),
      ],
      [MCP_SERVER],
    );
    await open();
    await act(async () => {
      control('cogni_cortex__*', 'auto_approve').click();
    });
    // run_code_unsafe was set apart (Block): the change would rewrite it.
    expect(document.body.textContent).toContain('Change every tool of this server?');
    expect(document.body.textContent).toContain(
      'This sets all 2 tools of Cogni Cortex to Run without asking, including the ones you set one by one.',
    );
    expect(actions.setAgentApprovalRuleAction.mock.calls).toEqual([]);

    // What the server holds after the write (setApprovalRuleRepo rewrites the
    // covered rows): the tab reads it back after a server row.
    actions.listAgentApprovalRulesAction.mockImplementation(async () => ({
      ok: true as const,
      data: [
        row('cogni_cortex__*', 'auto_approve'),
        row('cogni_cortex__read_page', 'auto_approve'),
        row('cogni_cortex__run_code_unsafe', 'auto_approve'),
      ],
    }));
    await act(async () => {
      [...document.body.querySelectorAll('button')]
        .find((b) => b.textContent === 'Change all')!
        .click();
    });
    await act(async () => {});
    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'cogni_cortex__*',
      action: 'auto_approve',
    });
    expect(pressed('cogni_cortex__run_code_unsafe')).toEqual(['auto_approve']);
    expect(pressed('cogni_cortex__read_page')).toEqual(['auto_approve']);
  });

  it('without a server row, the server line says new tools follow the level, and refuses nothing', async () => {
    await render([], [row('cogni_cortex__read_page', 'require_approval')], [MCP_SERVER]);
    expect(container.textContent).toContain(
      'Not set: tools added later start with the workspace autonomy level.',
    );
    expect(container.querySelector('[data-testid="autonomy-unset-cogni_cortex__*"]')).toBeNull();
  });
});

describe('Run commands : une ligne, comme tout outil (#468, #917) @cap:regler-autonomie/ecran', () => {
  const runPressed = () => pressed('run_command');

  beforeEach(() => {
    actions.setRunCommandRuleAction.mockClear();
    actions.setRunCommandRuleAction.mockImplementation(async () => ({
      ok: true,
      data: undefined,
    }));
  });

  it('chaque ligne allume SON choix, et la phrase dit ce qu’elle fait', async () => {
    for (const action of ['auto_approve', 'require_approval', 'block'] as const) {
      await render([], [row('run_command', action)]);
      expect(runPressed(), action).toEqual([action]);
      act(() => root.unmount());
      document.body.innerHTML = '';
    }
    await render([], [row('run_command', 'require_approval')]);
    expect(container.textContent).toContain('Every command asks for your approval.');
  });

  it('there is no "no choice" state and no "Let the workspace autonomy decide"', async () => {
    const text = await render([], [row('run_command', 'auto_approve')]);
    expect(container.querySelector('[data-testid="run-command-reset"]')).toBeNull();
    expect(container.querySelector('[data-testid="run-command-no-rule"]')).toBeNull();
    expect(text).not.toContain('workspace autonomy decides');
  });

  it('says the floor no setting lifts', async () => {
    await render([], [row('run_command', 'auto_approve')]);
    expect(container.querySelector('[data-testid="autonomy-note-run_command"]')?.textContent).toBe(
      'A command that can wipe this machine (formatting a disk, a fork bomb) always asks, whatever this setting says.',
    );
  });

  it('Block et Ask s’enregistrent sans confirmation, et envoient LEUR action', async () => {
    await render([], [row('run_command', 'auto_approve')]);
    await act(async () => {
      control('run_command', 'block').click();
    });
    expect(actions.setRunCommandRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      action: 'block',
    });
    expect(runPressed()).toEqual(['block']);
  });

  it('« Run without asking » demande d’abord, et n’écrit rien avant la réponse', async () => {
    await render([], [row('run_command', 'require_approval')]);
    await act(async () => {
      control('run_command', 'auto_approve').click();
    });
    expect(document.body.textContent).toContain('Run commands without asking?');
    expect(actions.setRunCommandRuleAction.mock.calls).toEqual([]);
    await act(async () => {
      [...document.body.querySelectorAll('button')]
        .find((b) => b.textContent === 'Run without asking' && b.closest('[role="dialog"]'))!
        .click();
    });
    expect(actions.setRunCommandRuleAction.mock.calls).toEqual([
      [{ agentId: AGENT_ID, action: 'auto_approve' }],
    ]);
  });

  it('un refus du serveur remet le choix d’avant', async () => {
    actions.setRunCommandRuleAction.mockImplementation(async () => ({
      ok: false,
      code: 'forbidden',
      message: 'Only the workspace owner can change how this agent runs commands.',
    }));
    await render([], [row('run_command', 'require_approval')]);
    await act(async () => {
      control('run_command', 'block').click();
    });
    expect(runPressed()).toEqual(['require_approval']);
  });
});

describe("les textes de l'onglet Autonomie @cap:regler-autonomie/ecran", () => {
  it('ouvre sur ce que le propriétaire décide ici, et d’où vient un réglage', async () => {
    const text = await render();
    expect(text).toContain(
      'Choose what this agent can do on its own, what needs your approval, and what it cannot do. Every tool it has is listed on this tab with its setting.',
    );
    expect(text).toContain(
      "A tool starts with the setting of the workspace autonomy level, in Settings. What you set here is what applies, from the agent's next step.",
    );
  });

  it('dit ce que devient un outil bloqué', async () => {
    const text = await render();
    expect(text).toContain(
      'Blocked tools stay visible to the agent. If it tries to use one, it is told the tool is blocked.',
    );
  });

  it('présente les outils natifs, et les rend par label et summary', async () => {
    const text = await render();
    expect(text).toContain('Write a workspace file');
    expect(text).toContain('Create or replace a file safely.');
    expect(text).toContain(
      'Always available. The agent needs this tool to finish a job or explain why it is stuck. It cannot be blocked.',
    );
  });

  it('porte les trois décisions du curseur', async () => {
    const text = await render();
    expect(text).toContain('Run without asking');
    expect(text).toContain('Ask for approval');
    expect(text).toContain('Block');
  });

  it('rend une operation de connecteur par ses textes de proprietaire, jamais par sa description', async () => {
    const text = await render([CONNECTOR]);
    expect(text).toContain('Publish to Cloudflare Workers');
    expect(text).not.toContain('Publish a built static site/app directory');
    expect(text).toContain('Legacy operation');
  });

  it('dit ce que sont les commandes, et la liste qui les borne', async () => {
    await render([], [row('run_command', 'auto_approve')]);
    expect(container.textContent).toContain(
      'Commands run without asking, except the kinds of action below set to Ask me or Never.',
    );
    expect(container.textContent).toContain('What it may do with a shell');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="shell-advanced"]')!.click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Run commands on this machine');
    expect(text).toContain('Allowed commands');
  });

  it("dit ce que l'agent peut faire de son équipe, et ce qu'être en lecture seule veut dire", async () => {
    const text = await render();
    expect(text).toContain('Let this agent change its team');
    expect(text).toContain('Read-only agent');
  });
});
