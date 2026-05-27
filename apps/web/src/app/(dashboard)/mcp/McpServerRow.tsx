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
    <div className="bg-paper border border-rule-2 rounded-xl px-5 py-4">
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
                className="bg-hover border border-rule rounded-md px-2 py-1 text-sm text-ink focus:border-ink-3 focus:outline-none w-full max-w-xs"
              />
              <button
                type="button"
                onClick={performRename}
                disabled={isPending}
                className="text-xs text-ok hover:text-ok disabled:opacity-40"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenameValue(instance.name);
                  setIsRenaming(false);
                }}
                className="text-xs text-ink-3 hover:text-ink-2"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-ink font-medium">{instance.name}</span>
              <button
                type="button"
                onClick={() => setIsRenaming(true)}
                aria-label="Rename MCP server"
                className="text-ink-4 hover:text-ink-3 transition-colors text-xs leading-none"
                title="Rename"
              >
                ✎
              </button>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3 font-mono">
                {catalogLabel}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ok">
                connected
              </span>
            </div>
          )}
          {description && <p className="text-xs text-ink-3 mt-0.5">{description}</p>}
          <p className="text-xs text-ink-4 mt-1">
            {instance.toolCount} tool{instance.toolCount === 1 ? '' : 's'} discovered
            {instance.apiKeyLast4 ? ` · key …${instance.apiKeyLast4}` : ''}
          </p>
        </div>
        <div className="shrink-0 flex gap-2 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => setRotateOpen((v) => !v)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink disabled:opacity-40"
          >
            {rotateOpen ? 'Cancel' : 'Rotate key'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium border border-err/30 text-err rounded-md hover:border-err/30 hover:text-err disabled:opacity-40"
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* Rotate API key panel. Verifies the new key against the MCP server
          (tools/list + optional probe) BEFORE persisting, so a bad paste
          can't silently break the next job. */}
      {rotateOpen && (
        <div className="space-y-3 pt-3 mt-3 border-t border-rule-2">
          <div>
            <label htmlFor={`mcp-rotate-${instance.id}`} className="block text-xs text-ink-3 mb-1">
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
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
            />
            <p className="text-[11px] text-ink-4 mt-1">
              Agent assignments stay intact — the key is verified against the server before being
              saved.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <button
              type="button"
              onClick={performRotate}
              disabled={isPending || !newApiKey.trim()}
              className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
            >
              {isPending ? 'Verifying…' : 'Save new key'}
            </button>
            <button
              type="button"
              onClick={() => {
                setNewApiKey('');
                setRotateOpen(false);
              }}
              className="text-xs text-ink-3 hover:text-ink underline"
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
