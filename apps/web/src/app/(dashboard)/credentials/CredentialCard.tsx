'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import CountPill from '@/components/ui/CountPill';

import type { ActionResult } from '@/lib/actions.ts';

type DeleteFn = (id: string) => Promise<ActionResult<{ disconnected: number }>>;
type RenameFn = (id: string, name: string) => Promise<ActionResult<void>>;
type RefreshFn = (id: string) => Promise<ActionResult<{ expiresAt: Date | null }>>;

/** Credential types that support access-token refresh. */
const REFRESH_SUPPORTED: ReadonlySet<string> = new Set(['google-oauth', 'airtable-oauth']);

/** Human-readable label per credential type. */
const TYPE_LABELS: Record<string, string> = {
  'google-oauth': 'Google',
  'notion-oauth': 'Notion',
  'airtable-oauth': 'Airtable',
};

/** Relative expiry string for a token expiry date. */
function formatExpiry(date: Date | null): string {
  if (!date) return '';
  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const abs = Math.abs(diffSec);

  let magnitude: string;
  if (abs < 60) {
    magnitude = `${abs}s`;
  } else if (abs < 3600) {
    magnitude = `${Math.round(abs / 60)} min`;
  } else if (abs < 86400) {
    magnitude = `${Math.round(abs / 3600)} h`;
  } else {
    magnitude = `${Math.round(abs / 86400)} d`;
  }

  return diffSec >= 0 ? `expires in ${magnitude}` : `expired ${magnitude} ago`;
}

function isExpired(date: Date | null): boolean {
  return !!date && date.getTime() < Date.now();
}

export type CredentialEntry = {
  id: string;
  name: string;
  type: 'google-oauth' | 'notion-oauth' | 'airtable-oauth';
  accountName: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  inUseBy: { connectorSlug: string; connectorId: string }[];
  /** Non-null when the at-rest payload could not be decrypted. */
  decryptError: string | null;
};

interface Props {
  credential: CredentialEntry;
  onDelete: DeleteFn;
  onRename: RenameFn;
  onRefresh: RefreshFn;
}

export default function CredentialCard({ credential, onDelete, onRename, onRefresh }: Props) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState(credential.name);
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, startRefreshTransition] = useTransition();

  const supportsRefresh = REFRESH_SUPPORTED.has(credential.type);
  const expired = isExpired(credential.expiresAt);
  const expiryText = formatExpiry(credential.expiresAt);
  const typeLabel = TYPE_LABELS[credential.type] ?? credential.type;
  const inUseCount = credential.inUseBy.length;
  const scopeList = credential.scopes ? credential.scopes.split(/\s+/).filter(Boolean) : [];

  function performDelete() {
    setDeleteOpen(false);
    startTransition(async () => {
      const r = await onDelete(credential.id);
      if (!r.ok) {
        toast.error(r.message);
      } else {
        toast.success(`Credential "${credential.name}" deleted`);
      }
    });
  }

  function performRename() {
    const trimmed = renameName.trim();
    if (!trimmed || trimmed === credential.name) {
      setRenameOpen(false);
      return;
    }
    startTransition(async () => {
      const r = await onRename(credential.id, trimmed);
      if (!r.ok) {
        toast.error(r.message);
      } else {
        toast.success('Credential renamed');
        setRenameOpen(false);
      }
    });
  }

  function performRefresh() {
    startRefreshTransition(async () => {
      const r = await onRefresh(credential.id);
      if (!r.ok) {
        toast.error(r.message ?? 'Refresh failed');
      } else {
        toast.success('Token refreshed');
      }
    });
  }

  return (
    <div className="bg-paper border border-rule-2 rounded-xl p-5 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-ink truncate">{credential.name}</h3>
            <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider bg-indigo-500/15 text-indigo-400 shrink-0">
              {typeLabel}
            </span>
          </div>
          {credential.accountName && (
            <p className="text-xs text-ink-3 mt-0.5">{credential.accountName}</p>
          )}
          {/* Status line.
              - Refreshable providers (Google, Airtable): stable "Auto-refreshes
                when used" copy. The runner refreshes the access token
                transparently on use, so an "expired" alarm here is misleading
                — the access_token can be past expiry while the refresh_token
                is still valid, which is the steady state for any credential
                used less than once an hour. Real refresh failures surface
                via the runner's path (the agent's job fails with a clear
                error), or via the explicit Refresh button on this card.
              - Non-refreshable providers (Notion): real timer + amber on
                expiry because the user actually has to reconnect manually. */}
          {supportsRefresh ? (
            <p className="text-xs text-ink-3 mt-0.5">Auto-refreshes when used</p>
          ) : expiryText ? (
            <p className={`text-xs mt-0.5 ${expired ? 'text-warn' : 'text-ink-3'}`}>{expiryText}</p>
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex gap-2 shrink-0 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => setRenameOpen(true)}
            disabled={isPending || isRefreshing}
            className="px-3 py-1.5 text-xs font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink disabled:opacity-40"
          >
            Rename
          </button>
          {supportsRefresh && (
            <button
              type="button"
              onClick={performRefresh}
              disabled={isRefreshing || isPending}
              className="px-3 py-1.5 text-xs font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink disabled:opacity-40"
            >
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            disabled={isPending || isRefreshing}
            className="px-3 py-1.5 text-xs font-medium border border-err/30 text-err rounded-md hover:border-err hover:text-err disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Decrypt error banner — payload ciphertext can't be read
          (master key rotated or row corrupted). Credential is unusable
          regardless of provider state. */}
      {credential.decryptError && (
        <div className="px-3 py-2 rounded border border-err/30 bg-warn-bg text-xs text-err">
          <span className="font-semibold">Cannot decrypt this credential.</span> The encrypted
          payload could not be read (master key changed or row corrupted). Delete and recreate it.
        </div>
      )}

      {/* Scopes — compact pill; hover for the full list (raw OAuth scope URLs
          are long and used to make the card sprawl). */}
      {scopeList.length > 0 && <CountPill items={scopeList} noun="scope" />}

      {/* In-use chips */}
      {inUseCount > 0 && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[11px] text-ink-4 uppercase tracking-wider font-semibold mr-1">
            Used by
          </span>
          {credential.inUseBy.map((u) => (
            <Link
              key={u.connectorId}
              href="/connectors"
              className="px-2 py-0.5 rounded text-[11px] bg-hover text-ink-3 hover:text-ink hover:bg-hover-2 transition-colors font-mono"
            >
              {u.connectorSlug}
            </Link>
          ))}
        </div>
      )}

      {/* Rename inline form */}
      {renameOpen && (
        <div className="pt-2 border-t border-rule-2 space-y-2">
          <label className="block text-xs text-ink-3">New display name</label>
          <input
            type="text"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') performRename();
              if (e.key === 'Escape') setRenameOpen(false);
            }}
            autoFocus
            className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={performRename}
              disabled={isPending}
              className="px-3 py-1.5 text-xs font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setRenameOpen(false);
                setRenameName(credential.name);
              }}
              className="px-3 py-1.5 text-xs font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
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
    </div>
  );
}
