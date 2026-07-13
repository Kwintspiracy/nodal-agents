'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ArrowsClockwise, Trash } from '@phosphor-icons/react';
import {
  deleteMcpServerAction,
  updateMcpServerApiKeyAction,
  type McpServerInstance,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import McpEditForm from './McpEditForm.tsx';

interface Props {
  instance: McpServerInstance;
  /** Catalog label for the slug (e.g. "Cogni Cortex"). Falls back to instance.name. */
  catalogLabel: string;
  description: string;
  /** Closes the wrapping edit Modal (UX-B6). Called after a successful
   *  Disconnect (the instance no longer exists), after Save/Cancel on the
   *  structural config form, and after a successful key rotation — the modal
   *  is non-dismissable so this is the only way out besides those. */
  onClose: () => void;
}

/**
 * McpServerRow — the full edit surface for one installed MCP server,
 * rendered inside the Modal that McpInstalledTable's Edit action opens.
 *
 * Previously this was itself an accordion (toggled by the row's Edit icon)
 * that contained its OWN "Edit config" icon, which toggled a SECOND nested
 * accordion (McpEditForm) — the exact double-Edit pattern flagged as the
 * worst UX in the app (UX-B6). Fixed by flattening: McpEditForm's fields are
 * always shown here (no inner toggle), and its Name field already covers
 * renaming (it submits `name` as part of updateMcpServerConfigAction), so the
 * old inline rename pencil is gone too. Rotate-key and Disconnect stay as
 * distinct, clearly-labelled actions (not another "Edit").
 */
export default function McpServerRow({ instance, catalogLabel, description, onClose }: Props) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Rotate-key state. Collapsed by default so the sensitive input isn't
  // sitting visible on the page; revealed via its own button.
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
      onClose();
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
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            {catalogLabel}
          </p>
          {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
          <p className="mt-1 text-xs text-ink-4">
            {instance.toolCount} tool{instance.toolCount === 1 ? '' : 's'} discovered
            {instance.apiKeyLast4 ? ` · key …${instance.apiKeyLast4}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <RowActionButton
            square
            icon={<ArrowsClockwise size={16} />}
            title={rotateOpen ? 'Cancel rotate' : 'Rotate secret'}
            onClick={() => setRotateOpen((v) => !v)}
            disabled={isPending}
          />
          <RowActionButton
            square
            icon={<Trash size={16} />}
            title="Disconnect"
            tone="danger"
            onClick={() => setConfirmOpen(true)}
            disabled={isPending}
          />
        </div>
      </div>

      {/* Rotate API key panel. Verifies the new key against the MCP server
          (tools/list + optional probe) BEFORE persisting, so a bad paste
          can't silently break the next job. */}
      {rotateOpen && (
        <div className="space-y-3 border-t border-rule-2 pt-3">
          <div>
            <label htmlFor={`mcp-rotate-${instance.id}`} className="mb-1 block text-xs text-ink-3">
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
              className="w-full rounded-md border border-rule bg-hover px-2 py-1.5 font-mono text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
            />
            <p className="mt-1 text-[12px] text-ink-4">
              Agent assignments stay intact — the key is verified against the server before being
              saved.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={performRotate}
              disabled={isPending || !newApiKey.trim()}
              className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-canvas hover:brightness-[0.92] disabled:opacity-50"
            >
              {isPending ? 'Verifying…' : 'Save new key'}
            </button>
            <button
              type="button"
              onClick={() => {
                setNewApiKey('');
                setRotateOpen(false);
              }}
              className="text-xs text-ink-3 underline hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Structural config — always visible, no nested Edit toggle. */}
      <div className="border-t border-rule-2 pt-3">
        <McpEditForm mcpServerId={instance.id} onDone={onClose} onCancel={onClose} />
      </div>

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
