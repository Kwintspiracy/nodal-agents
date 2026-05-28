'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import FleetPicker, { type Fleet } from './ui/FleetPicker';
import { switchWorkspaceAction, createWorkspaceAction, type WorkspaceRow } from '@/lib/actions';

/**
 * Map a WorkspaceRow to the Fleet shape expected by FleetPicker.
 * - tag: first 2 letters of name, uppercased (fallback: "WS")
 * - color: cycle through a small palette based on the workspace slug hash
 */
const PALETTE = [
  '#d4ff2e',
  '#74b9ff',
  '#a29bfe',
  '#fd79a8',
  '#55efc4',
  '#fdcb6e',
  '#e17055',
  '#6c5ce7',
];

function pickColor(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0]!;
}

function rowToFleet(ws: WorkspaceRow): Fleet {
  const tag = ws.icon ? ws.icon.slice(0, 2) : ws.name.slice(0, 2).toUpperCase() || 'WS';
  return {
    id: ws.id,
    name: ws.name,
    tag,
    color: pickColor(ws.slug),
  };
}

interface Props {
  workspaces: WorkspaceRow[];
}

export default function WorkspaceSwitcher({ workspaces }: Props) {
  const router = useRouter();
  const [isSwitching, startSwitchTransition] = useTransition();
  const [isCreating, startCreateTransition] = useTransition();

  // New-workspace inline form state
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const fleets = workspaces.map(rowToFleet);
  const active = workspaces.find((w) => w.active);
  const activeId = active?.id ?? fleets[0]?.id ?? '';

  function handleSwitch(id: string) {
    if (id === activeId || isSwitching) return;
    startSwitchTransition(async () => {
      const result = await switchWorkspaceAction({ id });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      router.refresh();
    });
  }

  function handleOpenNew() {
    setShowNewForm(true);
    setNewName('');
    // Focus the input on next paint
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    startCreateTransition(async () => {
      const createResult = await createWorkspaceAction({ name });
      if (!createResult.ok) {
        toast.error(createResult.message);
        return;
      }
      // Switch to the new workspace immediately
      const switchResult = await switchWorkspaceAction({ id: createResult.data.id });
      if (!switchResult.ok) {
        toast.error(switchResult.message);
        return;
      }
      setShowNewForm(false);
      setNewName('');
      toast.success(`Workspace "${name}" created`);
      router.refresh();
    });
  }

  return (
    <div>
      <FleetPicker
        fleets={fleets}
        activeId={activeId}
        onChange={handleSwitch}
        disabled={isSwitching || fleets.length === 0}
        onNewWorkspace={handleOpenNew}
      />

      {showNewForm && (
        <form
          onSubmit={handleCreateSubmit}
          className="mx-3.5 mt-1 rounded-[9px] border border-rule-2 bg-paper p-2.5"
        >
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-4">
            New workspace
          </p>
          <div className="flex gap-1.5">
            <input
              ref={inputRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name…"
              maxLength={60}
              disabled={isCreating}
              className="min-w-0 flex-1 rounded-md border border-rule bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isCreating || !newName.trim()}
              className="shrink-0 rounded-md bg-ink px-3 py-1.5 text-[12px] font-medium text-canvas hover:brightness-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreating ? '…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowNewForm(false)}
              disabled={isCreating}
              className="shrink-0 rounded-md border border-rule px-2.5 py-1.5 text-[12px] text-ink-3 hover:border-rule-2 hover:text-ink-2 disabled:opacity-50"
            >
              ✕
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
