'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  deleteMcpServerAction,
  renameMcpServerAction,
  updateMcpServerApiKeyAction,
  type McpServerInstance,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

interface Props {
  instance: McpServerInstance;
  /** Catalog label for the slug (e.g. "Cogni Cortex"). Falls back to instance.name. */
  catalogLabel: string;
  description: string;
}

export default function McpServerRow({ instance, catalogLabel, description }: Props) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Rename state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(instance.name);

  // Rotate-key state. Collapsed by default so the sensitive input isn't
  // sitting visible on the page; same UX as ConnectorForm.
  const [rotateOpen, setRotateOpen] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteMcpServerAction(instance.id);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${instance.name} disconnected`);
    });
  }

  function performRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === instance.name) {
      setIsRenaming(false);
      return;
    }
    startTransition(async () => {
      const r = await renameMcpServerAction(instance.id, trimmed);
      if (!r.ok) {
        toast.error(r.message);
      } else {
        toast.success('Renamed');
        setIsRenaming(false);
      }
    });
  }

  function performRotate() {
    const trimmed = newApiKey.trim();
    if (!trimmed) {
      toast.error('New API key is required');
      return;
    }
    startTransition(async () => {
      const r = await updateMcpServerApiKeyAction(instance.id, trimmed);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${instance.name} key rotated`);
      setRotateOpen(false);
      setNewApiKey('');
    });
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Instance name — inline rename */}
          {isRenaming ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') performRename();
                  if (e.key === 'Escape') {
                    setRenameValue(instance.name);
                    setIsRenaming(false);
                  }
                }}
                className="bg-neutral-800 border border-neutral-600 rounded-md px-2 py-1 text-sm text-white focus:border-neutral-400 focus:outline-none w-full max-w-xs"
              />
              <button
                type="button"
                onClick={performRename}
                disabled={isPending}
                className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenameValue(instance.name);
                  setIsRenaming(false);
                }}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white font-medium">{instance.name}</span>
              <button
                type="button"
                onClick={() => setIsRenaming(true)}
                aria-label="Rename MCP server"
                className="text-neutral-600 hover:text-neutral-400 transition-colors text-xs leading-none"
                title="Rename"
              >
                ✎
              </button>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 font-mono">
                {catalogLabel}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                connected
              </span>
            </div>
          )}
          {description && <p className="text-xs text-neutral-500 mt-0.5">{description}</p>}
          <p className="text-xs text-neutral-600 mt-1">
            {instance.toolCount} tool{instance.toolCount === 1 ? '' : 's'} discovered
            {instance.apiKeyLast4 ? ` · key …${instance.apiKeyLast4}` : ''}
          </p>
        </div>
        <div className="shrink-0 flex gap-2 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => setRotateOpen((v) => !v)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
          >
            {rotateOpen ? 'Cancel' : 'Rotate key'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* Rotate API key panel. Verifies the new key against the MCP server
          (tools/list + optional probe) BEFORE persisting, so a bad paste
          can't silently break the next job. */}
      {rotateOpen && (
        <div className="space-y-3 pt-3 mt-3 border-t border-neutral-800/60">
          <div>
            <label
              htmlFor={`mcp-rotate-${instance.id}`}
              className="block text-xs text-neutral-500 mb-1"
            >
              New API key
            </label>
            <input
              id={`mcp-rotate-${instance.id}`}
              type="password"
              autoComplete="off"
              autoFocus
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') performRotate();
                if (e.key === 'Escape') {
                  setNewApiKey('');
                  setRotateOpen(false);
                }
              }}
              placeholder="Paste the new key"
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
            />
            <p className="text-[11px] text-neutral-600 mt-1">
              Agent assignments stay intact — the key is verified against the server before being
              saved.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <button
              type="button"
              onClick={performRotate}
              disabled={isPending || !newApiKey.trim()}
              className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
            >
              {isPending ? 'Verifying…' : 'Save new key'}
            </button>
            <button
              type="button"
              onClick={() => {
                setNewApiKey('');
                setRotateOpen(false);
              }}
              className="text-xs text-neutral-500 hover:text-white underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={`Disconnect "${instance.name}"?`}
        message="The MCP connector and all its agent assignments will be removed. Re-connecting later requires the API key again."
        confirmLabel="Disconnect"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
