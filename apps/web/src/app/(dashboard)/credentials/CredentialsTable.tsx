'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { PencilSimple, ArrowClockwise, Trash } from '@phosphor-icons/react';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import CountPill from '@/components/ui/CountPill';
import StatusPill from '@/components/ui/StatusPill';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import RowActionButton from '@/components/ui/RowActionButton';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import TextInput from '@/components/ui/TextInput';
import Modal, { ModalFooter } from '@/components/ui/Modal.tsx';
import type { CredentialEntry } from './CredentialCard.tsx';
import type { ActionResult } from '@/lib/actions.ts';
import { formatExpiry, isExpired } from '@/lib/format-time';

type DeleteFn = (id: string) => Promise<ActionResult<{ disconnected: number }>>;
type RenameFn = (id: string, name: string) => Promise<ActionResult<void>>;
type RefreshFn = (id: string) => Promise<ActionResult<{ expiresAt: Date | null }>>;

const REFRESH_SUPPORTED: ReadonlySet<string> = new Set([
  'google-oauth',
  'airtable-oauth',
  'microsoft-oauth',
]);
const TYPE_LABELS: Record<string, string> = {
  'google-oauth': 'Google',
  'notion-oauth': 'Notion',
  'airtable-oauth': 'Airtable',
  'microsoft-oauth': 'Microsoft',
};

/**
 * CredentialsTable — saved OAuth credentials as a table (Provider · Account ·
 * Scopes · Status · Used by · Actions), matching the connectors / skills tables.
 * Rename opens a non-dismissable Modal (UX-B6: editing a list object is always
 * a modal, never an inline expand row); delete confirms; refresh is inline.
 */
export default function CredentialsTable({
  credentials,
  onDelete,
  onRename,
  onRefresh,
}: {
  credentials: CredentialEntry[];
  onDelete: DeleteFn;
  onRename: RenameFn;
  onRefresh: RefreshFn;
}) {
  return (
    <Table>
      <THead>
        <Th>Provider</Th>
        <Th>Account</Th>
        <Th>Scopes</Th>
        <Th>Status</Th>
        <Th>Used by</Th>
        <Th align="right">Actions</Th>
      </THead>
      <tbody>
        {credentials.map((c) => (
          <CredentialRow
            key={c.id}
            credential={c}
            onDelete={onDelete}
            onRename={onRename}
            onRefresh={onRefresh}
          />
        ))}
      </tbody>
    </Table>
  );
}

function CredentialRow({
  credential,
  onDelete,
  onRename,
  onRefresh,
}: {
  credential: CredentialEntry;
  onDelete: DeleteFn;
  onRename: RenameFn;
  onRefresh: RefreshFn;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState(credential.name);
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, startRefresh] = useTransition();

  const supportsRefresh = REFRESH_SUPPORTED.has(credential.type);
  const expired = isExpired(credential.expiresAt);
  const typeLabel = TYPE_LABELS[credential.type] ?? credential.type;
  const scopeList = credential.scopes ? credential.scopes.split(/\s+/).filter(Boolean) : [];
  const usedBy = credential.inUseBy.map((u) => u.connectorSlug);
  const inUseCount = credential.inUseBy.length;

  function performDelete() {
    setDeleteOpen(false);
    startTransition(async () => {
      const r = await onDelete(credential.id);
      if (r.ok) toast.success(`Credential "${credential.name}" deleted`);
      else toast.error(r.message);
    });
  }
  function closeRename() {
    setRenameOpen(false);
    setRenameName(credential.name);
  }
  function performRename() {
    const trimmed = renameName.trim();
    if (!trimmed || trimmed === credential.name) return closeRename();
    startTransition(async () => {
      const r = await onRename(credential.id, trimmed);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Credential renamed');
        setRenameOpen(false);
      }
    });
  }
  function performRefresh() {
    startRefresh(async () => {
      const r = await onRefresh(credential.id);
      if (r.ok) toast.success('Token refreshed');
      else toast.error(r.message ?? 'Refresh failed');
    });
  }

  const status = credential.decryptError
    ? { variant: 'warn' as const, label: 'Decrypt error' }
    : supportsRefresh
      ? { variant: 'done' as const, label: 'Auto-refresh' }
      : expired
        ? { variant: 'warn' as const, label: 'Expired' }
        : { variant: 'done' as const, label: 'Connected' };

  return (
    <>
      <Tr>
        {/* Provider */}
        <Td>
          <div className="flex items-center gap-2.5">
            <span className="inline-flex shrink-0 rounded bg-indigo-500/15 px-2 py-0.5 font-mono text-micro-10 tracking-wider text-indigo-400 uppercase">
              {typeLabel}
            </span>
            <span className="truncate text-medium-13 text-ink">{credential.name}</span>
          </div>
        </Td>

        {/* Account */}
        <Td className="text-body-13 text-ink-2">{credential.accountName ?? '—'}</Td>

        {/* Scopes */}
        <Td>
          {scopeList.length > 0 ? (
            <CountPill items={scopeList} noun="scope" />
          ) : (
            <span className="text-mono-11 text-ink-4">—</span>
          )}
        </Td>

        {/* Status */}
        <Td>
          <StatusPill variant={status.variant} label={status.label} />
          {!supportsRefresh && !credential.decryptError && credential.expiresAt && (
            <div className="mt-0.5 text-micro-11 text-ink-4">
              {formatExpiry(credential.expiresAt)}
            </div>
          )}
        </Td>

        {/* Used by */}
        <Td>
          {usedBy.length > 0 ? (
            <CountPill items={usedBy} noun="connector" />
          ) : (
            <span className="text-mono-11 text-ink-4">—</span>
          )}
        </Td>

        {/* Actions */}
        <Td>
          <div className="flex items-center justify-end gap-2">
            <RowActionButton
              square
              icon={<PencilSimple size={16} />}
              title="Rename credential"
              onClick={() => setRenameOpen(true)}
              disabled={isPending || isRefreshing}
            />
            {supportsRefresh && (
              <RowActionButton
                square
                icon={<ArrowClockwise size={16} />}
                title={isRefreshing ? 'Refreshing…' : 'Refresh'}
                onClick={performRefresh}
                disabled={isPending || isRefreshing}
              />
            )}
            <RowActionButton
              square
              icon={<Trash size={16} />}
              title="Delete"
              tone="danger"
              onClick={() => setDeleteOpen(true)}
              disabled={isPending || isRefreshing}
            />
          </div>
        </Td>
      </Tr>

      {/* Decrypt-error sub-row */}
      {credential.decryptError && (
        <Tr hover={false}>
          <td colSpan={6} className="px-5 pb-3">
            <div className="rounded border border-err/30 bg-warn-bg px-3 py-2 text-xs text-err">
              <span className="font-semibold">Cannot decrypt this credential.</span> The encrypted
              payload could not be read (master key changed or row corrupted). Delete and recreate
              it.
            </div>
          </td>
        </Tr>
      )}

      {/* Rename — non-dismissable Modal (UX-B6), replaces the old inline
          expand row: closing happens only via Cancel/Save below. */}
      <Modal
        open={renameOpen}
        onClose={closeRename}
        title="Rename credential"
        dismissable={false}
        footer={
          <ModalFooter>
            <PrimaryButton variant="neutral" onClick={closeRename}>
              Cancel
            </PrimaryButton>
            <PrimaryButton variant="ink" onClick={performRename} disabled={isPending}>
              {isPending ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </ModalFooter>
        }
      >
        <TextInput
          label="New display name"
          type="text"
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') performRename();
          }}
          autoFocus
          placeholder="New display name"
        />
      </Modal>

      <ConfirmDialog
        open={deleteOpen}
        title={`Delete "${credential.name}"?`}
        message={
          inUseCount > 0
            ? `This credential is used by ${inUseCount} connector${inUseCount !== 1 ? 's' : ''} which will be disconnected.`
            : 'This credential will be permanently deleted.'
        }
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}
