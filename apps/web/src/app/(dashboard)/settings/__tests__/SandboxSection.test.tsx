// SandboxSection.test.tsx — la section Sandbox de Réglages → Safety (#876) :
// ce qu'elle MONTRE de l'état que le runner rapporte, et ce que ses gestes
// demandent. Le moteur (l'interrupteur relu à chaque commande, la composition
// des dossiers) est prouvé par sandbox-switch.test.ts et policy.test.ts.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SandboxView } from '@/lib/sandbox-actions.ts';

const setSandboxEnabledAction = vi.hoisted(() =>
  vi.fn(async (_: { enabled: boolean }) => ({ ok: true as const, data: undefined })),
);
const addSandboxFolderAction = vi.hoisted(() =>
  vi.fn(
    async (_: {
      path: string;
      confirmedBroad?: boolean;
    }): Promise<
      | { ok: true; data: { kind: 'added' } | { kind: 'confirm'; broad: 'drive-root' | 'home' } }
      | { ok: false; code: string; message: string }
    > => ({ ok: true, data: { kind: 'added' } }),
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

const ACTIVE: SandboxView = {
  platform: 'win32',
  status: {
    state: 'available',
    backend: 'mxc-processcontainer',
    limits: ['SANDBOX_NETWORK_RAW_TCP_LOCAL: raw TCP to a local service has no route'],
  },
  enabled: true,
  allowedFolders: [
    { path: 'C:\\Users\\me\\.nodalai\\tool-cache', source: 'tool-cache', state: 'allowed' },
    { path: 'C:\\Users\\me\\.ollama\\models', source: 'ollama', state: 'allowed' },
    { path: 'C:\\Users\\me\\.cache\\huggingface', source: 'huggingface', state: 'removed' },
    { path: 'E:\\gone', source: 'user', state: 'missing' },
  ],
  agents: [
    {
      id: 'a1',
      name: 'Alfred',
      runtime: 'nodal',
      folders: [{ label: 'dev', path: 'D:\\Dev' }],
    },
  ],
  sharedFolder: 'C:\\Users\\me\\.nodalai\\workspaces\\e\\shared',
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
const switchButton = () => container.querySelector('button[role="switch"]') as HTMLButtonElement;
const buttonNamed = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => text(b) === name) as HTMLButtonElement;

describe('SandboxSection shows what the runner reports @cap:executer-une-commande/ecran', () => {
  it('active: the state, the backend, the named limit, and the perimeter with its real paths', async () => {
    await render(ACTIVE);
    expect(text(byTestId('sandbox-state-value'))).toBe('Active');
    expect(text(byTestId('sandbox-state'))).toContain('mxc-processcontainer');
    expect(text(byTestId('sandbox-limits'))).toContain(
      'Local services and the internet are reached over HTTP and HTTPS only.',
    );
    expect(text(byTestId('sandbox-limits'))).toContain('SANDBOX_NETWORK_RAW_TCP_LOCAL');
    const agents = byTestId('sandbox-agent-folders')!;
    expect(agents.querySelector('a')?.getAttribute('href')).toBe('/agents/a1/edit');
    expect(text(agents)).toContain('D:\\Dev');
    expect(text(agents)).toContain('C:\\Users\\me\\.nodalai\\workspaces\\e\\shared');
    expect(text(byTestId('sandbox-read-refused'))).toContain('C:\\Users\\me\\.nodalai');
    expect(text(byTestId('sandbox-network'))).toContain('3000');
    expect(text(byTestId('sandbox-network'))).toContain('25444');
    expect(switchButton().getAttribute('aria-checked')).toBe('true');
  });

  it('each allowed folder says its source and state; the tool cache has no Remove and says why', async () => {
    await render(ACTIVE);
    const rows = [...document.querySelectorAll('[data-testid="sandbox-allowed-folder"]')];
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual([
      'allowed',
      'allowed',
      'removed',
      'missing',
    ]);
    expect(text(rows[0]!)).toContain(
      'Tool cache. Stays: without it, npm and pip start from an empty cache on every command.',
    );
    expect(rows[0]!.querySelector('button')).toBeNull();
    expect(text(rows[1]!)).toContain('Ollama');
    expect(text(rows[1]!.querySelector('button'))).toBe('Remove');
    expect(text(rows[2]!.querySelector('button'))).toBe('Allow again');
    expect(text(rows[3]!)).toContain('Added by you. Folder not found, ignored');
  });

  it('turning it off asks first and names the consequence; confirmed, the switch goes off', async () => {
    await render(ACTIVE);
    await act(async () => switchButton().click());
    expect(setSandboxEnabledAction).not.toHaveBeenCalled();
    expect(text(document.body)).toContain('Turn the sandbox off?');
    expect(text(document.body)).toContain(
      'they can write anywhere your account can, and read Nodal',
    );
    await act(async () => buttonNamed('Turn off').click());
    expect(setSandboxEnabledAction.mock.calls).toEqual([[{ enabled: false }]]);
    expect(switchButton().getAttribute('aria-checked')).toBe('false');
    expect(text(container)).toContain('The sandbox is off');
  });

  it('turning it back on asks nothing', async () => {
    await render({ ...ACTIVE, enabled: false });
    expect(text(container)).toContain('The sandbox is off');
    await act(async () => switchButton().click());
    expect(setSandboxEnabledAction.mock.calls).toEqual([[{ enabled: true }]]);
    expect(text(document.body)).not.toContain('Turn the sandbox off?');
  });

  it('adding a drive root shows the confirmation the action asks for, then adds it confirmed', async () => {
    addSandboxFolderAction.mockImplementationOnce(async () => ({
      ok: true,
      data: { kind: 'confirm', broad: 'drive-root' },
    }));
    await render(ACTIVE);
    await act(async () => buttonNamed('Add folder').click());
    await act(async () => (byTestId('pick') as HTMLButtonElement).click());
    expect(text(document.body)).toContain('Allow the whole D:\\ drive?');
    expect(text(document.body)).toContain(
      'Commands of this workspace will be able to write anywhere in D:\\.',
    );
    await act(async () => buttonNamed('Allow').click());
    expect(addSandboxFolderAction.mock.calls).toEqual([
      [{ path: 'D:\\', confirmedBroad: false }],
      [{ path: 'D:\\', confirmedBroad: true }],
    ]);
  });

  it('on a system without a sandbox yet, it says so and every control is off', async () => {
    await render({
      ...ACTIVE,
      platform: 'darwin',
      status: {
        state: 'unavailable',
        code: 'SANDBOX_NOT_IMPLEMENTED',
        reason: 'no sandbox backend for platform darwin yet',
      },
    });
    expect(text(container)).toContain('Not available on this system yet');
    expect(text(byTestId('sandbox-state-value'))).toContain('SANDBOX_NOT_IMPLEMENTED');
    expect(text(byTestId('sandbox-state'))).toContain('no sandbox backend for platform darwin yet');
    expect(switchButton().disabled).toBe(true);
    expect(switchButton().getAttribute('aria-checked')).toBe('false');
    expect(buttonNamed('Add folder').disabled).toBe(true);
    expect(buttonNamed('Remove').disabled).toBe(true);
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
