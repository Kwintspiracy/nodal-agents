// SandboxSection.test.tsx — la section Sandbox de Réglages → Safety (#876),
// d'après la maquette validée le 27/10 : ce qu'elle MONTRE de l'état que le
// runner rapporte, et ce que ses gestes demandent. Le moteur (l'interrupteur
// relu à chaque commande, la composition des dossiers, le regroupement par
// dossier, la place des commandes de chaque runtime) est prouvé par
// sandbox-switch.test.ts, policy.test.ts, sandbox.test.ts et provider.test.ts.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SandboxView } from '@/lib/sandbox-actions.ts';

type AddResult =
  | {
      ok: true;
      data:
        | { kind: 'added' }
        | { kind: 'confirm'; broad: 'volume-root' | 'home' }
        | { kind: 'refused'; code: string; within: string };
    }
  | { ok: false; code: string; message: string };

const setSandboxEnabledAction = vi.hoisted(() =>
  vi.fn(async (_: { enabled: boolean }) => ({ ok: true as const, data: undefined })),
);
const addSandboxFolderAction = vi.hoisted(() =>
  vi.fn(
    async (_: { path: string; confirmedBroad?: boolean }): Promise<AddResult> => ({
      ok: true,
      data: { kind: 'added' },
    }),
  ),
);
vi.mock('@/lib/sandbox-actions.ts', () => ({
  setSandboxEnabledAction,
  addSandboxFolderAction,
  removeSandboxFolderAction: vi.fn(async () => ({ ok: true, data: undefined })),
  restoreSandboxFolderAction: vi.fn(async () => ({ ok: true, data: undefined })),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
/** Le sélecteur de dossiers du serveur, réduit à son geste : choisir un chemin. */
const PICKED = vi.hoisted(() => ({ path: 'D:\\' }));
vi.mock('@/app/(dashboard)/agents/[id]/edit/FolderPickerModal.tsx', async () => {
  const { default: PrimaryButton } = await import('@/components/ui/PrimaryButton');
  return {
    default: ({ open, onSelect }: { open: boolean; onSelect: (p: string) => void }) =>
      open ? (
        <PrimaryButton data-testid="pick" onClick={() => onSelect(PICKED.path)}>
          pick
        </PrimaryButton>
      ) : null,
  };
});

const { default: SandboxSection } = await import('../SandboxSection.tsx');

const alfred = { id: 'a1', name: 'Alfred', runtime: 'nodal', commands: 'sandbox' as const };
const lead = { id: 'a2', name: 'Lead-Dev', runtime: 'nodal', commands: 'sandbox' as const };
const devC = { id: 'a3', name: 'Dev C', runtime: 'claude-code', commands: 'outside' as const };
const java = { id: 'a4', name: 'Java', runtime: 'nodal', commands: 'sandbox' as const };

const ACTIVE: SandboxView = {
  platform: 'win32',
  status: {
    state: 'available',
    backend: 'mxc-processcontainer',
    limits: [
      'SANDBOX_DATA_DIR_NEW_CHILD: diagnostic text from the backend',
      'SANDBOX_NETWORK_RAW_TCP_LOCAL: raw TCP to a local service has no route',
    ],
  },
  enabled: true,
  allowedFolders: [
    { path: 'C:\\Users\\me\\.nodalai\\tool-cache', source: 'tool-cache', state: 'allowed' },
    { path: 'C:\\Users\\me\\.cache\\huggingface', source: 'huggingface', state: 'allowed' },
    { path: 'D:\\Models', source: 'user', state: 'allowed' },
    { path: 'E:\\old-renders', source: 'user', state: 'missing' },
    { path: 'C:\\Users\\me\\.ollama\\models', source: 'ollama', state: 'removed' },
  ],
  agentFolders: [
    { path: 'C:\\Users\\me\\Documents\\Dev', agents: [lead, devC] },
    { path: 'C:\\Users\\me\\Documents\\Nodal', agents: [alfred] },
  ],
  agentsWithoutFolder: [java],
  sharedFolder: 'C:\\Users\\me\\.nodalai\\workspaces\\e\\shared',
  writableFolderCount: 6,
  readRefused: ['C:\\Users\\me\\.nodalai'],
  network: { deniedPorts: [3000, 3001, 25444] },
  isOwner: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setSandboxEnabledAction.mockClear();
  addSandboxFolderAction.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(view: SandboxView): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SandboxSection initial={view} />);
  });
  return container;
}

const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const all = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
const switchButton = () => container.querySelector('button[role="switch"]') as HTMLButtonElement;
const buttonNamed = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => text(b) === name) as HTMLButtonElement;

describe('SandboxSection, active @cap:executer-une-commande/ecran', () => {
  it('the state card says it confines, names the engine in words and when it applies', async () => {
    await render(ACTIVE);
    expect(byTestId('sandbox-state-card')?.getAttribute('data-regime')).toBe('active');
    expect(text(byTestId('sandbox-state-title'))).toBe('Commands are confined');
    const facts = text(byTestId('sandbox-state-facts'));
    expect(facts).toContain('Windows container (MXC)');
    expect(facts).not.toContain('mxc-processcontainer');
    expect(facts).toContain('from the next command');
    expect(facts).not.toContain('Results');
    expect(text(byTestId('sandbox-limits-toggle'))).toBe('2 known limits');
    expect(switchButton().getAttribute('aria-checked')).toBe('true');
  });

  it('the known limits open as plain sentences indexed by code, never the backend text', async () => {
    await render(ACTIVE);
    expect(byTestId('sandbox-limits')).toBeNull();
    await act(async () => (byTestId('sandbox-limits-toggle') as HTMLButtonElement).click());
    const limits = text(byTestId('sandbox-limits'));
    expect(limits).toContain('What the sandbox does not stop');
    expect(limits).toContain(
      "A file added to Nodal's data folder during a run is refused from the next run on.",
    );
    expect(limits).toContain('SANDBOX_DATA_DIR_NEW_CHILD');
    expect(limits).not.toContain('diagnostic text from the backend');
  });

  it('the three perimeter cards: the folder count the runner gives, the data folder, the refused ports', async () => {
    await render(ACTIVE);
    const cards = [...byTestId('sandbox-perimeter')!.children].map(text);
    expect(cards[0]).toContain('Can write');
    expect(cards[0]).toContain('6 folders');
    expect(cards[1]).toContain("Nodal's data");
    expect(cards[1]).toContain('C:\\Users\\me\\.nodalai');
    expect(cards[2]).toContain('Web only');
    expect(cards[2]).toContain('25444');
    expect(byTestId('sandbox-perimeter')!.children[0]!.getAttribute('href')).toBe(
      '#sandbox-agent-folders',
    );
  });

  it('allowed folders: name, parent, source tag, one action column, removed ones apart', async () => {
    await render(ACTIVE);
    const rows = all('sandbox-allowed-folder');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual([
      'allowed',
      'allowed',
      'allowed',
      'missing',
      'removed',
    ]);
    expect(text(rows[0]!)).toBe('tool-cacheC:\\Users\\me\\.nodalai\\NodalAlways on');
    expect(rows[0]!.querySelector('button')).toBeNull();
    expect(rows[0]!.querySelector('[title]')?.getAttribute('title')).toBe(
      'C:\\Users\\me\\.nodalai\\tool-cache',
    );
    expect(text(rows[1]!)).toContain('Found · Hugging Face');
    expect(text(rows[1]!.querySelector('button'))).toBe('Remove');
    expect(text(rows[2]!)).toContain('Added by you');
    expect(text(rows[3]!)).toContain('Not found, skipped');
    expect(text(byTestId('sandbox-removed-folders'))).toContain('Removed by you');
    expect(text(rows[4]!)).toContain('Found · Ollama');
    expect(text(rows[4]!.querySelector('button'))).toBe('Allow again');
  });

  it('agent folders are grouped by folder, with a pill per agent; a runtime outside the sandbox is warned, not hidden', async () => {
    await render(ACTIVE);
    const groups = all('sandbox-agent-folder');
    expect(groups).toHaveLength(2);
    expect(text(groups[0]!)).toContain('Dev');
    const pills = [...groups[0]!.querySelectorAll('a')];
    expect(pills.map((p) => [text(p), p.getAttribute('href')])).toEqual([
      ['Lead-Dev', '/agents/a2/edit'],
      ['Dev C', '/agents/a3/edit'],
    ]);
    expect(pills[1]!.getAttribute('title')).toBe(
      "Dev C runs on Claude Code. Its commands run outside Nodal's sandbox.",
    );
    expect(pills[0]!.getAttribute('title')).toBeNull();
    expect(text(byTestId('sandbox-shared-folder'))).toContain('Every agent');
    const notes = text(byTestId('sandbox-agent-folders-notes'));
    expect(notes).toContain('No folder of its own, so it writes only in shared: Java.');
    expect(notes).toContain("Dev C runs on Claude Code. Its commands run outside Nodal's sandbox.");
  });

  it('turning it off asks first with the consequence; confirmed, the card turns to off', async () => {
    await render(ACTIVE);
    await act(async () => switchButton().click());
    expect(setSandboxEnabledAction).not.toHaveBeenCalled();
    expect(text(document.body)).toContain('Turn off the sandbox?');
    expect(text(document.body)).toContain(
      "Commands of every agent in this workspace will run without confinement. They can write anywhere you can and read Nodal's data.",
    );
    await act(async () => buttonNamed('Turn off').click());
    expect(setSandboxEnabledAction.mock.calls).toEqual([[{ enabled: false }]]);
    expect(byTestId('sandbox-state-card')?.getAttribute('data-regime')).toBe('off');
  });

  it('adding a volume root shows the confirmation the action asks for, then adds it confirmed', async () => {
    addSandboxFolderAction.mockImplementationOnce(async () => ({
      ok: true,
      data: { kind: 'confirm', broad: 'volume-root' },
    }));
    await render(ACTIVE);
    await act(async () => buttonNamed('Add folder').click());
    await act(async () => (byTestId('pick') as HTMLButtonElement).click());
    expect(text(document.body)).toContain('Allow all of D:\\ ?');
    expect(text(document.body)).toContain(
      'Commands of every agent in this workspace could write anywhere on this drive, Windows and your programs included.',
    );
    await act(async () => buttonNamed('Allow D:\\').click());
    expect(addSandboxFolderAction.mock.calls).toEqual([
      [{ path: 'D:\\', confirmedBroad: false }],
      [{ path: 'D:\\', confirmedBroad: true }],
    ]);
  });

  it("a refusal of Nodal's data folder is said inline, and can be dismissed", async () => {
    addSandboxFolderAction.mockImplementationOnce(async () => ({
      ok: true,
      data: {
        kind: 'refused',
        code: 'SANDBOX_REACH_IS_NODAL_HOME',
        within: 'C:\\Users\\me\\.nodalai',
      },
    }));
    PICKED.path = 'C:\\Users\\me\\.nodalai';
    try {
      await render(ACTIVE);
      await act(async () => buttonNamed('Add folder').click());
      await act(async () => (byTestId('pick') as HTMLButtonElement).click());
      expect(text(byTestId('sandbox-refusal'))).toBe(
        "C:\\Users\\me\\.nodalai is Nodal's data folder. Commands can never write there.",
      );
      expect(byTestId('sandbox-refusal')!.querySelector('[role="alert"]')).not.toBeNull();
      await act(async () =>
        (document.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click(),
      );
      expect(byTestId('sandbox-refusal')).toBeNull();
    } finally {
      PICKED.path = 'D:\\';
    }
  });

  it('someone who is not the owner sees everything and changes nothing', async () => {
    await render({ ...ACTIVE, isOwner: false });
    expect(text(container)).toContain('Only the workspace owner can change the sandbox.');
    expect(switchButton().disabled).toBe(true);
    expect(buttonNamed('Add folder').disabled).toBe(true);
  });

  it('uses no em dash (UI copy rule)', async () => {
    await render(ACTIVE);
    expect(text(container)).not.toContain('—');
  });
});

describe('SandboxSection, off and unavailable @cap:executer-une-commande/ecran', () => {
  it('off: the card says so in warn, the perimeter is Anywhere / Nothing / Everything, folders are kept but not applied', async () => {
    await render({ ...ACTIVE, enabled: false });
    expect(byTestId('sandbox-state-card')?.getAttribute('data-regime')).toBe('off');
    expect(text(byTestId('sandbox-state-title'))).toBe('Commands are not confined');
    const facts = text(byTestId('sandbox-state-facts'));
    expect(facts).toContain('Windows container (MXC), ready');
    expect(facts).toContain('SANDBOX_DISABLED');
    expect(byTestId('sandbox-limits-toggle')).toBeNull();
    const cards = [...byTestId('sandbox-perimeter')!.children].map(text);
    expect(cards[0]).toContain('Anywhere');
    expect(cards[0]).toContain('Everything your Windows account can write.');
    expect(cards[1]).toContain('Nothing');
    expect(cards[2]).toContain('Everything');
    expect(text(byTestId('sandbox-allowed-folders'))).toContain(
      'Not applied while the sandbox is off. Kept for when you turn it back on.',
    );
    expect(all('sandbox-allowed-folder')[1]!.querySelector('button')).toBeNull();
    expect(byTestId('sandbox-agent-folders')).toBeNull();
  });

  it('turning it back on asks nothing', async () => {
    await render({ ...ACTIVE, enabled: false });
    await act(async () => switchButton().click());
    expect(setSandboxEnabledAction.mock.calls).toEqual([[{ enabled: true }]]);
    expect(text(document.body)).not.toContain('Turn off the sandbox?');
  });

  it('on a system without an engine yet, it names the system, and every control is off', async () => {
    await render({
      ...ACTIVE,
      platform: 'darwin',
      status: {
        state: 'unavailable',
        code: 'SANDBOX_NOT_IMPLEMENTED',
        reason: 'no sandbox backend for platform darwin yet',
      },
    });
    expect(text(byTestId('sandbox-state-title'))).toBe('Not available on macOS yet');
    expect(text(byTestId('sandbox-state-card'))).toContain(
      'Commands run without confinement on this system. The macOS sandbox comes in a later version.',
    );
    expect(text(byTestId('sandbox-state-facts'))).toContain('none on this system');
    expect(text(byTestId('sandbox-state-facts'))).toContain('SANDBOX_NOT_IMPLEMENTED');
    expect(text(container)).not.toContain('owner only');
    expect(switchButton().disabled).toBe(true);
    expect(switchButton().getAttribute('aria-checked')).toBe('false');
    expect(buttonNamed('Add folder').disabled).toBe(true);
    expect(text(byTestId('sandbox-allowed-folders'))).toContain(
      'You can set them once the sandbox runs on this system.',
    );
    expect(all('sandbox-allowed-folder')).toHaveLength(0);
    expect(byTestId('sandbox-agent-folders')).toBeNull();
  });
});
