'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  deleteMcpServerAction,
  updateMcpServerApiKeyAction,
  type McpServerInstance,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import TextInput from '@/components/ui/TextInput';
import FieldLabel from '@/components/ui/FieldLabel';
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
      {/* Metadata — no action buttons in this row (UX-B7: buttons in the
          header used to overlap adjacent content on narrow widths). Actions
          live in their own row below instead. */}
      <div className="min-w-0">
        <p className="font-mono text-label-11 uppercase tracking-wider text-ink-3">
          {catalogLabel}
        </p>
        {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
        <p className="mt-1 text-xs text-ink-4">
          {instance.toolCount} tool{instance.toolCount === 1 ? '' : 's'} discovered
          {instance.apiKeyLast4 ? ` · key …${instance.apiKeyLast4}` : ''}
        </p>
      </div>

      {/* Contextual actions — PrimaryButton row in the body (UX-B7). Rotate
          is a neutral toggle; Disconnect uses the danger variant so it reads
          as destructive without needing its own isolated footer slot (the
          modal's actual footer, below, belongs to McpEditForm's Save/Cancel). */}
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton
          variant="neutral"
          size="sm"
          onClick={() => setRotateOpen((v) => !v)}
          disabled={isPending}
        >
          {rotateOpen ? 'Cancel rotate' : 'Rotate secret'}
        </PrimaryButton>
        <PrimaryButton
          variant="danger"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={isPending}
        >
          Disconnect
        </PrimaryButton>
      </div>

      {/* Rotate API key panel. Verifies the new key against the MCP server
          (tools/list + optional probe) BEFORE persisting, so a bad paste
          can't silently break the next job. */}
      {rotateOpen && (
        <div className="space-y-3 border-t border-rule-2 pt-3">
          <div>
            <FieldLabel htmlFor={`mcp-rotate-${instance.id}`}>New API key</FieldLabel>
            <TextInput
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
              className="font-mono"
            />
            <p className="mt-1 text-body-12 text-ink-4">
              Agent assignments stay intact - the key is verified against the server before being
              saved.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <PrimaryButton
              variant="ink"
              size="sm"
              onClick={performRotate}
              disabled={isPending || !newApiKey.trim()}
            >
              {isPending ? 'Verifying…' : 'Save new key'}
            </PrimaryButton>
            <PrimaryButton
              variant="neutral"
              size="sm"
              onClick={() => {
                setNewApiKey('');
                setRotateOpen(false);
              }}
            >
              Cancel
            </PrimaryButton>
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
