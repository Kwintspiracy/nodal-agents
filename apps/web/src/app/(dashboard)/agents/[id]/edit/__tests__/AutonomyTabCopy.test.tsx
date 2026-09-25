// AutonomyTabCopy.test.tsx : les textes de l'onglet Approvals (issue #382), et
// ce qu'une règle confinée à un dossier y montre (issue #361).
//
// Ce que ça prouve, sur le DOM rendu : chaque phrase de la table « Screen copy »
// de l'issue est bien À L'ÉCRAN, et l'onglet montre `label`/`summary` des outils
// natifs, jamais leur `description`. Les textes sont ceux de Quentin, relus
// contre le code ; ce fichier est ce qui empêche une reformulation silencieuse.
//
// L'onglet est rendu en entier, avec ses sections filles, parce que la copie
// est répartie entre elles : une assertion par section prouverait chaque bout
// sans prouver que le propriétaire les lit ensemble.

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
    // Typée avec son argument : les assertions portent sur CE QUI EST ENVOYÉ
    // au serveur, pas sur un compteur d'appels (invariant #5).
    setAgentApprovalRuleAction: vi.fn(
      async (_raw: {
        agentId: string;
        toolName: string;
        action: string;
      }): Promise<
        { ok: true; data: undefined } | { ok: false; code: string; message: string }
      > => ({ ok: true, data: undefined }),
    ),
    setRunCommandRuleAction: vi.fn(
      async (_raw: {
        agentId: string;
        action: 'auto_approve' | 'require_approval' | 'block' | null;
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

/**
 * Deux operations de connecteur : celle qui declare ses textes (issue #382) et
 * celle qui n'en declare pas encore. Le repli de la seconde est ce que l'ecran
 * montre aux douze adaptateurs non encore repris.
 */
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

async function render(
  connectors: unknown[] = [],
  rules: Rule[] = [],
  mcpServers: unknown[] = [],
): Promise<string> {
  actions.listAgentApprovalRulesAction.mockImplementation(async () => ({
    ok: true as const,
    data: rules,
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
        commandAllowlist={null}
        mayChangeTeam={false}
        shellPolicy={null}
        workspaceAutonomy={null}
      />,
    );
  });
  // Les deux chargements (règles, outils natifs) se résolvent après le montage.
  await act(async () => {});
  return container.textContent ?? '';
}

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

  it('rend une operation de connecteur par ses textes de proprietaire, jamais par sa description', async () => {
    // Le chemin `ownerTextFor` : sans ce cas, remplacer le repli par
    // `op.description ?? op.summary` laisserait les suites vertes et ramenerait
    // le mur ecrit pour le modele (revue Reviewer C, passe 1, P2-11).
    const text = await render([CONNECTOR]);

    expect(text).toContain('Publish to Cloudflare Workers');
    expect(text).toContain(
      'Publish a built site or app from the workspace. It goes live at a workers.dev address.',
    );
    expect(text).not.toContain('Publish a built static site/app directory');
    expect(text).not.toContain('Deploy to Workers');
  });

  it("montre encore le nom et la description d'un connecteur pas encore repris", async () => {
    // Douze adaptateurs n'ont pas encore leurs deux textes. Tant qu'ils ne les
    // ont pas, leur ligne reste celle d'avant plutot qu'une ligne vide.
    const text = await render([CONNECTOR]);

    expect(text).toContain('Legacy operation');
    expect(text).toContain(
      'What this connector has always shown, for an adapter not yet rewritten.',
    );
  });

  it('dit ce que sont les commandes, et la liste qui les borne', async () => {
    await render();
    // Plus de « asks by default » (#464) : ce que les commandes font VRAIMENT
    // dépend de l'autonomie de l'espace, et sans elle la phrase le dit.
    expect(container.textContent).not.toContain('Commands ask for your approval by default.');
    expect(container.textContent).toContain('How commands run depends on the workspace autonomy.');
    expect(container.textContent).toContain('What it may do with a shell');
    expect(container.textContent).toContain('Run code written into a command');
    // La liste de programmes est sous « Advanced », repliée quand aucune n'est posée.
    expect(container.textContent).not.toContain('Allowed commands');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="shell-advanced"]')!.click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Run commands on this machine');
    expect(text).toContain(
      'Any command the agent writes, in a shell on this machine. Every command is logged.',
    );
    expect(text).toContain(
      'No choice set: the workspace autonomy decides, as the line above says.',
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

describe('une règle confinée à un dossier @cap:regler-autonomie/ecran', () => {
  const FOLDER_RULE: Rule = {
    id: 'r1',
    toolName: 'file_write',
    action: 'auto_approve',
    conditionJson: { workspacePath: 'D:\APPS\Dev' },
    workspaceLabel: 'Dev',
  };

  function control(slug: string, action: string): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      `[data-testid="autonomy-btn-${slug}-${action}"]`,
    );
    if (!el) throw new Error(`no control for ${slug} ${action}`);
    return el;
  }

  function dialogText(): string {
    return document.body.textContent ?? '';
  }

  it('nomme le dossier sur la ligne, au lieu de laisser lire « partout »', async () => {
    await render([], [FOLDER_RULE]);
    expect(container.querySelector('[data-testid="autonomy-folder-file_write"]')?.textContent).toBe(
      'in Dev',
    );
  });

  it('ne dit rien pour une règle sans condition, et le dit pour sa voisine', async () => {
    // Revue Reviewer C, passe 2, question 8 : sur la seule ABSENCE, ce test
    // passait aussi sur le code d'avant, qui n'affichait jamais rien. Les deux
    // lignes sont rendues ensemble, dans le même DOM : l'une porte un dossier,
    // l'autre non.
    await render(
      [CONNECTOR],
      [
        {
          id: 'r2',
          toolName: 'file_write',
          action: 'block',
          conditionJson: null,
          workspaceLabel: null,
        },
        {
          id: 'r3',
          toolName: 'legacy_write',
          action: 'auto_approve',
          conditionJson: { workspacePath: 'D:\APPS\Dev' },
          workspaceLabel: 'Dev',
        },
      ],
    );
    expect(container.querySelector('[data-testid="autonomy-folder-file_write"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="autonomy-folder-legacy_write"]')?.textContent,
    ).toBe('in Dev');
  });

  it("avertit AVANT d'enregistrer, et n'écrit rien tant que personne n'a répondu", async () => {
    await render([], [FOLDER_RULE]);
    actions.setAgentApprovalRuleAction.mockClear();

    await act(async () => {
      control('file_write', 'block').click();
    });

    expect(dialogText()).toContain('Remove the folder limit?');
    expect(dialogText()).toContain(
      'This rule applies only in Dev today. Saving from here applies your choice everywhere this agent works.',
    );
    // Revue Reviewer C, passe 3, C5 : la carte d'approbation n'existe que
    // quand une demande existe. Y envoyer le propriétaire, c'est peut-être
    // l'envoyer devant un écran vide.
    expect(dialogText()).not.toContain('approval card');
    expect(actions.setAgentApprovalRuleAction.mock.calls).toEqual([]);
  });

  it('enregistre le choix une fois la perte acceptée', async () => {
    await render([], [FOLDER_RULE]);
    actions.setAgentApprovalRuleAction.mockClear();

    await act(async () => {
      control('file_write', 'block').click();
    });
    const confirm = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Remove the limit',
    );
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.click();
    });

    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'file_write',
      action: 'block',
    });
  });

  it('garde la règle telle quelle quand on renonce', async () => {
    await render([], [FOLDER_RULE]);
    actions.setAgentApprovalRuleAction.mockClear();

    await act(async () => {
      control('file_write', 'block').click();
    });
    const cancel = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel',
    );
    await act(async () => {
      cancel!.click();
    });

    expect(actions.setAgentApprovalRuleAction.mock.calls).toEqual([]);
    expect(container.querySelector('[data-testid="autonomy-folder-file_write"]')?.textContent).toBe(
      'in Dev',
    );
  });

  it('avertit AUSSI pour « Ask for approval », pas seulement pour « Block »', async () => {
    // Revue Reviewer C, passe 2, question 9 : la suite ne couvrait que `block`,
    // donc restreindre la boîte à ce seul cas serait passé inaperçu, et un
    // passage en « Ask for approval » aurait perdu le dossier sans un mot.
    await render([], [FOLDER_RULE]);
    actions.setAgentApprovalRuleAction.mockClear();

    await act(async () => {
      control('file_write', 'require_approval').click();
    });

    expect(dialogText()).toContain('Remove the folder limit?');
    expect(actions.setAgentApprovalRuleAction.mock.calls).toEqual([]);
  });

  it("n'annonce aucun élargissement pour « Run without asking », que le serveur refuse", async () => {
    // Revue Reviewer C, passe 1, C1 : `refuseGlobalGrantOverFolderRule` refuse
    // cette écriture. Faire confirmer « la limite va sauter » serait annoncer
    // ce qui n'arrivera pas. L'appel part, et c'est le serveur qui parle.
    actions.setAgentApprovalRuleAction.mockImplementation(async () => ({
      ok: false as const,
      code: 'validation_failed',
      message: 'file_write is already approved for this agent only inside D:\APPS\Dev.',
    }));
    await render([], [{ ...FOLDER_RULE, action: 'require_approval' }]);
    actions.setAgentApprovalRuleAction.mockClear();

    await act(async () => {
      control('file_write', 'auto_approve').click();
    });

    expect(dialogText()).not.toContain('Remove the folder limit?');
    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'file_write',
      action: 'auto_approve',
    });
  });

  it('ne retire pas le dossier de la ligne avant la réponse du serveur', async () => {
    // C2 : poser tout de suite une ligne sans condition ferait lire
    // « partout » sur une règle que la base garde confinée.
    let resolveSave: ((r: { ok: true; data: undefined }) => void) | undefined;
    actions.setAgentApprovalRuleAction.mockImplementation(
      () =>
        new Promise<{ ok: true; data: undefined }>((r) => {
          resolveSave = r;
        }),
    );
    await render([], [FOLDER_RULE]);

    await act(async () => {
      control('file_write', 'block').click();
    });
    const confirm = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Remove the limit',
    );
    await act(async () => {
      confirm!.click();
    });

    // L'écriture est partie, la réponse n'est pas revenue : la ligne dit encore
    // ce que la base porte.
    expect(container.querySelector('[data-testid="autonomy-folder-file_write"]')?.textContent).toBe(
      'in Dev',
    );

    // Le serveur répond, et la relecture ramène ce qu'il a VRAIMENT écrit :
    // une règle sans condition. Le dossier quitte la ligne à ce moment-là, et
    // pas avant.
    actions.listAgentApprovalRulesAction.mockImplementation(async () => ({
      ok: true as const,
      data: [
        {
          id: 'r1',
          toolName: 'file_write',
          action: 'block',
          conditionJson: {},
          workspaceLabel: null,
        },
      ],
    }));
    await act(async () => {
      resolveSave?.({ ok: true, data: undefined });
    });
    await act(async () => {});
    expect(container.querySelector('[data-testid="autonomy-folder-file_write"]')).toBeNull();
  });

  it('nomme le dossier même sur une ligne qui ne peut pas être bloquée', async () => {
    // Revue Reviewer C, passe 3, C4 : le verrou n'interdit que le blocage, une
    // règle de dossier existe ici comme ailleurs.
    await render(
      [],
      [
        {
          id: 'r5',
          toolName: 'return_result',
          action: 'auto_approve',
          conditionJson: { workspacePath: 'D:\APPS\Dev' },
          workspaceLabel: 'Dev',
        },
      ],
    );
    expect(
      container.querySelector('[data-testid="autonomy-folder-return_result"]')?.textContent,
    ).toBe('in Dev');
    // La raison du verrou reste, elle : les deux se lisent ensemble.
    expect(container.querySelector('[data-testid="autonomy-locked-return_result"]')).not.toBeNull();
  });

  it("une relecture n'écrase pas une écriture encore en vol", async () => {
    // Revue Reviewer C, passe 3, C2. La relecture déclenchée par la règle de
    // dossier peut lire la base AVANT que l'écriture partie entre-temps sur un
    // autre outil y soit visible. Elle ramène alors l'ancienne valeur, et
    // comme la seconde réponse ne relit rien, l'écran resterait faux.
    let resolveFolderSave: ((r: { ok: true; data: undefined }) => void) | undefined;
    let resolveOtherSave: ((r: { ok: true; data: undefined }) => void) | undefined;
    actions.setAgentApprovalRuleAction.mockImplementation(
      (raw) =>
        new Promise<{ ok: true; data: undefined }>((r) => {
          if (raw.toolName === 'file_write') resolveFolderSave = r;
          else resolveOtherSave = r;
        }),
    );
    await render([CONNECTOR], [FOLDER_RULE]);

    // 1. La règle de dossier : confirmée, l'écriture part.
    await act(async () => {
      control('file_write', 'block').click();
    });
    await act(async () => {
      [...document.body.querySelectorAll('button')]
        .find((b) => b.textContent === 'Remove the limit')!
        .click();
    });

    // 2. Un autre outil, dont l'écriture est encore en vol.
    await act(async () => {
      control('legacy_write', 'block').click();
    });

    // 3. La première réponse arrive et déclenche une relecture qui n'a pas
    //    encore vu la seconde écriture.
    actions.listAgentApprovalRulesAction.mockImplementation(async () => ({
      ok: true as const,
      data: [
        {
          id: 'r1',
          toolName: 'file_write',
          action: 'block',
          conditionJson: {},
          workspaceLabel: null,
        },
      ],
    }));
    await act(async () => {
      resolveFolderSave?.({ ok: true, data: undefined });
    });
    await act(async () => {});

    // La ligne dont personne n'a le résultat garde ce que le propriétaire a
    // choisi, au lieu de retomber sur l'état d'avant.
    expect(control('legacy_write', 'block').getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      resolveOtherSave?.({ ok: true, data: undefined });
    });
  });

  it("n'affiche pas les règles de l'agent précédent quand on change d'agent", async () => {
    // Revue Reviewer C, passe 3, C1 : les règles étaient gardées telles quelles
    // tant que la lecture du nouvel agent n'avait pas abouti, dossiers compris.
    await render([], [FOLDER_RULE]);
    expect(container.querySelector('[data-testid="autonomy-folder-file_write"]')?.textContent).toBe(
      'in Dev',
    );

    // Le second agent, dont la lecture ÉCHOUE : c'est le cas qui compte. Une
    // lecture qui réussit remplace les règles de toute façon ; une lecture qui
    // échoue laissait celles d'avant à l'écran, sous le nom du nouvel agent.
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
          workspaceAutonomy={null}
        />,
      );
    });

    await act(async () => {});
    expect(container.querySelector('[data-testid="autonomy-folder-file_write"]')).toBeNull();
    // Et pas seulement le dossier : l'ACTION de l'agent précédent est partie
    // aussi. Sans cette ligne, le test passait sur le code d'avant la PR, qui
    // n'affichait jamais de dossier (revue Reviewer C, passe 4, question 5).
    expect(control('file_write', 'auto_approve').getAttribute('aria-pressed')).toBe('true');
    expect(control('file_write', 'block').getAttribute('aria-pressed')).toBe('false');
  });

  it('relâche la ligne quand la promesse d’enregistrement rejette', async () => {
    // Revue Reviewer C, passe 4, C1 : un rejet saute tout le `then`. La ligne
    // restait grise pour toujours, et protégée de toute relecture, sans un mot.
    actions.setAgentApprovalRuleAction.mockImplementation(async () => {
      throw new Error('network down');
    });
    await render([], [FOLDER_RULE]);

    await act(async () => {
      control('file_write', 'block').click();
    });
    await act(async () => {
      [...document.body.querySelectorAll('button')]
        .find((b) => b.textContent === 'Remove the limit')!
        .click();
    });
    await act(async () => {});

    expect(control('file_write', 'block').disabled).toBe(false);
  });

  it('prévient avant que la ligne Run commands ne remplace une règle de dossier', async () => {
    // Revue Reviewer C, passe 4, C3, puis #468 : changer la ligne REMPLACE la
    // règle. Quand elle ne valait que dans un dossier, c'est une permission
    // posée dossier par dossier qui disparaît, et rien sur cet onglet ne sait
    // la recréer.
    await render(
      [],
      [
        {
          id: 'r6',
          toolName: 'run_command',
          action: 'auto_approve',
          conditionJson: { workspacePath: 'D:\APPS\Dev' },
          workspaceLabel: 'Dev',
        },
      ],
    );
    actions.setRunCommandRuleAction.mockClear();

    expect(control('run_command', 'auto_approve').getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector('[data-testid="autonomy-folder-run_command"]')?.textContent,
    ).toBe('in Dev');
    await act(async () => {
      control('run_command', 'block').click();
    });

    expect(dialogText()).toContain('Replace the rule for this folder?');
    expect(dialogText()).toContain(
      'Commands run without asking only in Dev today. Changing this replaces that rule with one for every folder.',
    );
    expect(actions.setRunCommandRuleAction.mock.calls).toEqual([]);

    await act(async () => {
      [...document.body.querySelectorAll('button')]
        .find((b) => b.textContent === 'Replace the rule')!
        .click();
    });
    expect(actions.setRunCommandRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      action: 'block',
    });
  });

  // Revue de la PR #481 (Reviewer A) : le dialogue disait « Run without asking
  // only in Dev » quelle que soit la règle, promettait un remplacement que le
  // serveur refuse, et disait « Replace » pour une suppression.
  it('dit ce que la règle de dossier fait vraiment, et ce que le geste en fera', async () => {
    await render(
      [],
      [
        {
          id: 'r7',
          toolName: 'run_command',
          action: 'block',
          conditionJson: { workspacePath: 'D:\APPS\Dev' },
          workspaceLabel: 'Dev',
        },
      ],
    );
    actions.setRunCommandRuleAction.mockClear();

    await act(async () => {
      control('run_command', 'require_approval').click();
    });
    expect(dialogText()).toContain('Replace the rule for this folder?');
    expect(dialogText()).toContain('A rule blocks commands in Dev today.');
    expect(dialogText()).not.toContain('run without asking only in Dev');
    await act(async () => {
      [...document.body.querySelectorAll('button')]
        .find((b) => b.textContent === 'Cancel')!
        .click();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="run-command-reset"]')!.click();
    });
    expect(dialogText()).toContain('Remove the rule for this folder?');
    expect(dialogText()).toContain('The workspace autonomy then decides everywhere.');
    expect(actions.setRunCommandRuleAction.mock.calls).toEqual([]);
  });

  it('Run without asking par-dessus une règle de dossier ne promet pas un remplacement : le serveur tranche', async () => {
    await render(
      [],
      [
        {
          id: 'r8',
          toolName: 'run_command',
          action: 'block',
          conditionJson: { workspacePath: 'D:\APPS\Dev' },
          workspaceLabel: 'Dev',
        },
      ],
    );
    actions.setRunCommandRuleAction.mockClear();

    await act(async () => {
      control('run_command', 'auto_approve').click();
    });

    expect(dialogText()).not.toContain('Replace the rule');
    expect(actions.setRunCommandRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      action: 'auto_approve',
    });
  });

  it('nomme le dossier dans le nom accessible du curseur', async () => {
    await render([], [FOLDER_RULE]);
    const group = container.querySelector('[aria-label*="limited to Dev"]');
    expect(group?.getAttribute('aria-label')).toBe(
      'Approval rule for Write a workspace file, limited to Dev',
    );
  });

  it('nomme le dossier sur une ligne de CONNECTEUR, pas seulement sur un outil natif', async () => {
    const text = await render(
      [CONNECTOR],
      [
        {
          id: 'r3',
          toolName: 'cloudflare_deploy',
          action: 'auto_approve',
          conditionJson: { workspacePath: 'D:\APPS\Dev' },
          workspaceLabel: 'Dev',
        },
      ],
    );
    expect(text).toContain('Publish to Cloudflare Workers');
    expect(
      container.querySelector('[data-testid="autonomy-folder-cloudflare_deploy"]')?.textContent,
    ).toBe('in Dev');
  });

  it('nomme le dossier sur une ligne de SERVEUR MCP', async () => {
    await render(
      [],
      [
        {
          id: 'r4',
          toolName: 'cogni_cortex__*',
          action: 'auto_approve',
          conditionJson: { workspacePath: 'D:\APPS\Dev' },
          workspaceLabel: 'Dev',
        },
      ],
      [MCP_SERVER],
    );
    expect(
      container.querySelector('[data-testid="autonomy-folder-cogni_cortex__*"]')?.textContent,
    ).toBe('in Dev');
  });

  it("enregistre sans rien demander quand la règle n'a pas de dossier", async () => {
    await render([]);
    actions.setAgentApprovalRuleAction.mockClear();

    await act(async () => {
      control('file_write', 'block').click();
    });

    expect(dialogText()).not.toContain('Remove the folder limit?');
    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'file_write',
      action: 'block',
    });
  });
});

describe("les outils d'un serveur MCP, un par un @cap:regler-autonomie/ecran", () => {
  // Issue #357 : la section ne portait qu'une ligne PAR SERVEUR. Garder
  // `cogni_cortex__*` autonome et bloquer un seul de ses outils ne se disait
  // nulle part depuis la page de l'agent.

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

  function toolControl(name: string, action: string): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      `[data-testid="autonomy-btn-cogni_cortex__${name}-${action}"]`,
    );
    if (!el) throw new Error(`no control for ${name} ${action}`);
    return el;
  }

  it('annonce combien le serveur expose, et ne les montre que sur demande', async () => {
    await render([], [], [MCP_SERVER]);
    expect(fold().textContent).toContain('2 tools');
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="autonomy-mcp-tools-cogni_cortex"]')).toBeNull();

    await open();
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    const list = container.querySelector('[data-testid="autonomy-mcp-tools-cogni_cortex"]');
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain('read_page');
    expect(list!.textContent).toContain('run_code_unsafe');
    expect(list!.textContent).toContain('Run arbitrary code in the browser.');
  });

  it("sans règle sur l'outil exact, la ligne suit le serveur", async () => {
    await render([], [], [MCP_SERVER]);
    await open();
    expect(toolControl('read_page', 'inherit').getAttribute('aria-pressed')).toBe('true');
    expect(toolControl('read_page', 'block').getAttribute('aria-pressed')).toBe('false');
  });

  it("montre la valeur d'une règle déjà posée sur un outil exact", async () => {
    await render(
      [],
      [
        {
          id: 'r7',
          toolName: 'cogni_cortex__run_code_unsafe',
          action: 'block',
          conditionJson: null,
          workspaceLabel: null,
        },
      ],
      [MCP_SERVER],
    );
    await open();
    expect(toolControl('run_code_unsafe', 'block').getAttribute('aria-pressed')).toBe('true');
    // Sa voisine, elle, n'a pas de règle : elle suit toujours le serveur.
    expect(toolControl('read_page', 'inherit').getAttribute('aria-pressed')).toBe('true');
  });

  it("enregistre sur le NOM EXACT de l'outil, pas sur le motif du serveur", async () => {
    await render([], [], [MCP_SERVER]);
    await open();
    actions.setAgentApprovalRuleAction.mockClear();

    await act(async () => {
      toolControl('run_code_unsafe', 'block').click();
    });

    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'cogni_cortex__run_code_unsafe',
      action: 'block',
    });
  });

  it('« Follow the server » supprime la règle de l’outil', async () => {
    await render(
      [],
      [
        {
          id: 'r8',
          toolName: 'cogni_cortex__run_code_unsafe',
          action: 'block',
          conditionJson: null,
          workspaceLabel: null,
        },
      ],
      [MCP_SERVER],
    );
    await open();
    actions.setAgentApprovalRuleAction.mockClear();

    await act(async () => {
      toolControl('run_code_unsafe', 'inherit').click();
    });

    // `action: null` = supprimer la ligne, et non poser une quatrième valeur.
    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'cogni_cortex__run_code_unsafe',
      action: null,
    });
    // Et la LIGNE a disparu de l'écran, sans attendre un rechargement : sans
    // cela, le curseur resterait sur « Block » alors que la règle est partie
    // (revue Reviewer C, passe 4, P1-6).
    expect(toolControl('run_code_unsafe', 'inherit').getAttribute('aria-pressed')).toBe('true');
    expect(toolControl('run_code_unsafe', 'block').getAttribute('aria-pressed')).toBe('false');
  });

  it("ne liste que les outils que l'agent a vraiment", async () => {
    // Revue Reviewer C, C3 : une règle posée sur un outil retiré de la liste
    // blanche du serveur ne protège rien, et la ligne promettrait un contrôle
    // sans effet.
    await render([], [], [{ ...MCP_SERVER, enabledTools: ['read_page'] }]);
    expect(fold().textContent).toContain('1 tool');

    await open();
    const list = container.querySelector('[data-testid="autonomy-mcp-tools-cogni_cortex"]');
    expect(list!.textContent).toContain('read_page');
    expect(list!.textContent).not.toContain('run_code_unsafe');
  });

  it('la ligne du serveur dit sa portée, pas un instantané', async () => {
    // Revue Reviewer C, passes 2 et 3 : « All 5 current tools and any added
    // later » au-dessus de « 2 tools » faisait lire deux nombres contraires ;
    // et compter ce que l'agent tient aujourd'hui décrirait mal une règle qui
    // gouverne par nom, donc aussi un outil re-donné demain.
    const text = await render([], [], [{ ...MCP_SERVER, enabledTools: ['read_page'] }]);
    expect(text).toContain('Every tool from this server, including any you give this agent later.');
    // Pas de compte sur cette ligne : le motif `<prefix>__*` gouverne par nom,
    // donc aussi un outil re-donné demain. Le compte est dans le dépli.
    expect(text).not.toContain('current tools and any added later');
    expect(fold().textContent).toContain('1 tool');
  });

  it('sans liste blanche, la ligne du serveur parle bien de tout le serveur', async () => {
    const text = await render([], [], [MCP_SERVER]);
    expect(text).toContain('All 2 current tools and any added later.');
  });

  it("nomme les règles restées sur des outils que l'agent ne tient plus", async () => {
    // Revue Reviewer C, passe 2, Q4 : une règle survit au décochage de son
    // outil et reprend effet à son retour. Invisible, elle réapparaîtrait
    // « déjà posée » sans que rien ne l'ait dit.
    await render(
      [],
      [
        {
          id: 'r9',
          toolName: 'cogni_cortex__run_code_unsafe',
          action: 'block',
          conditionJson: null,
          workspaceLabel: null,
        },
      ],
      [{ ...MCP_SERVER, enabledTools: ['read_page'] }],
    );
    await open();
    expect(
      container.querySelector('[data-testid="autonomy-mcp-hidden-cogni_cortex"]')?.textContent,
    ).toContain('A rule is still stored for run_code_unsafe, which this agent no longer holds.');
  });

  it('accorde la phrase quand DEUX règles traînent', async () => {
    await render(
      [],
      [
        {
          id: 'r11',
          toolName: 'cogni_cortex__run_code_unsafe',
          action: 'block',
          conditionJson: null,
          workspaceLabel: null,
        },
        {
          id: 'r12',
          toolName: 'cogni_cortex__read_page',
          action: 'block',
          conditionJson: null,
          workspaceLabel: null,
        },
      ],
      // Aucun des deux outils n'est tenu par l'agent.
      [{ ...MCP_SERVER, enabledTools: [] }],
    );
    await open();
    expect(
      container.querySelector('[data-testid="autonomy-mcp-hidden-cogni_cortex"]')?.textContent,
    ).toContain(
      'Rules are still stored for read_page, run_code_unsafe, which this agent no longer holds.',
    );
  });

  it("ne dit rien de tel pour une règle posée sur un outil que l'agent tient", async () => {
    // Revue Reviewer C, passe 3, P1-4 : l'absence seule était satisfaite par
    // un calcul qui ne verrait plus rien. Ici une règle EXISTE, sur un outil
    // que l'agent tient : la ligne ne doit pas se déclencher pour autant.
    await render(
      [],
      [
        {
          id: 'r13',
          toolName: 'cogni_cortex__read_page',
          action: 'block',
          conditionJson: null,
          workspaceLabel: null,
        },
      ],
      [{ ...MCP_SERVER, enabledTools: ['read_page'] }],
    );
    await open();
    expect(container.querySelector('[data-testid="autonomy-mcp-hidden-cogni_cortex"]')).toBeNull();
    // Et la règle est bien là, sur sa propre ligne.
    expect(toolControl('read_page', 'block').getAttribute('aria-pressed')).toBe('true');
  });

  it('sur une règle de dossier, « Follow the server » dit ce qui sera supprimé', async () => {
    // Revue Reviewer C, passe 2, Q6 : les trois textes de ce dialogue n'étaient
    // assertés nulle part, donc les remettre à ceux de #361 passait inaperçu.
    await render(
      [],
      [
        {
          id: 'r10',
          toolName: 'cogni_cortex__run_code_unsafe',
          action: 'auto_approve',
          conditionJson: { workspacePath: 'D:\APPS\Dev' },
          workspaceLabel: 'Dev',
        },
      ],
      [MCP_SERVER],
    );
    await open();
    actions.setAgentApprovalRuleAction.mockClear();

    await act(async () => {
      toolControl('run_code_unsafe', 'inherit').click();
    });

    const dialog = document.body.textContent ?? '';
    expect(dialog).toContain('Delete this rule?');
    expect(dialog).toContain(
      "This rule applies only in Dev today. Following the server deletes this agent's rule on the tool.",
    );
    expect(actions.setAgentApprovalRuleAction.mock.calls).toEqual([]);

    await act(async () => {
      [...document.body.querySelectorAll('button')]
        .find((b) => b.textContent === 'Delete the rule')!
        .click();
    });
    expect(actions.setAgentApprovalRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'cogni_cortex__run_code_unsafe',
      action: null,
    });
  });

  it("dit, une fois, qu'une règle d'outil bat celle du serveur", async () => {
    const text = await render([], [], [MCP_SERVER]);
    expect(text).toContain(
      "A rule on one tool wins over the server's rule. These rows show the rules set for this agent.",
    );
  });
});

describe('Run commands : les trois choix de tout outil (#468) @cap:regler-autonomie/ecran', () => {
  function control(action: string): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      `[data-testid="autonomy-btn-run_command-${action}"]`,
    );
    if (!el) throw new Error(`no run_command control for ${action}`);
    return el;
  }

  function pressed(): string[] {
    return ['auto_approve', 'require_approval', 'block'].filter(
      (a) => control(a).getAttribute('aria-pressed') === 'true',
    );
  }

  const RULE = (action: 'auto_approve' | 'require_approval' | 'block'): Rule => ({
    id: 'rc',
    toolName: 'run_command',
    action,
    conditionJson: null,
    workspaceLabel: null,
  });

  beforeEach(() => {
    actions.setRunCommandRuleAction.mockClear();
    actions.setRunCommandRuleAction.mockImplementation(async () => ({
      ok: true,
      data: undefined,
    }));
  });

  it('sans règle, AUCUN choix n’est allumé, et la ligne dit qui décide', async () => {
    await render([], []);
    expect(pressed()).toEqual([]);
    expect(container.querySelector('[data-testid="run-command-no-rule"]')?.textContent).toBe(
      'No choice set: the workspace autonomy decides, as the line above says.',
    );
    expect(container.querySelector('[data-testid="run-command-reset"]')).toBeNull();
  });

  it('chaque règle allume SON choix', async () => {
    for (const action of ['auto_approve', 'require_approval', 'block'] as const) {
      await render([], [RULE(action)]);
      expect(pressed(), action).toEqual([action]);
      act(() => root.unmount());
      document.body.innerHTML = '';
    }
    await render([], []);
  });

  it('Block et Ask s’enregistrent sans confirmation, et envoient LEUR action', async () => {
    await render([], []);
    await act(async () => {
      control('block').click();
    });
    expect(actions.setRunCommandRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      action: 'block',
    });
    expect(pressed()).toEqual(['block']);

    await act(async () => {
      control('require_approval').click();
    });
    expect(actions.setRunCommandRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      action: 'require_approval',
    });
  });

  it('« Run without asking » demande d’abord, et n’écrit rien avant la réponse', async () => {
    await render([], []);
    await act(async () => {
      control('auto_approve').click();
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

  it('« Let the workspace autonomy decide » retire la règle', async () => {
    await render([], [RULE('block')]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="run-command-reset"]')!.click();
    });
    expect(actions.setRunCommandRuleAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      action: null,
    });
    expect(pressed()).toEqual([]);
  });

  it('un refus du serveur remet le choix d’avant', async () => {
    actions.setRunCommandRuleAction.mockImplementation(async () => ({
      ok: false,
      code: 'forbidden',
      message: 'Only the workspace owner can change how this agent runs commands.',
    }));
    await render([], [RULE('require_approval')]);
    await act(async () => {
      control('block').click();
    });
    expect(pressed()).toEqual(['require_approval']);
  });
});
