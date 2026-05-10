'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

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
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-white truncate">{credential.name}</h3>
            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-indigo-500/15 text-indigo-400 shrink-0">
              {typeLabel}
            </span>
          </div>
          {credential.accountName && (
            <p className="text-xs text-neutral-400 mt-0.5">{credential.accountName}</p>
          )}
          {/* Refreshable providers (Google, Airtable) display a stable
              "Auto-refreshes when used" — the runner refreshes the token
              transparently on use, so a countdown UI adds nothing but anxiety.
              Non-refreshable (Notion) keeps the real timer + amber alarm. */}
          {supportsRefresh && (
            <p className="text-xs text-neutral-500 mt-0.5">Auto-refreshes when used</p>
          )}
          {!supportsRefresh && expiryText && (
            <p className={`text-xs mt-0.5 ${expired ? 'text-amber-400' : 'text-neutral-500'}`}>
              {expiryText}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 shrink-0 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => setRenameOpen(true)}
            disabled={isPending || isRefreshing}
            className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
          >
            Rename
          </button>
          {supportsRefresh && (
            <button
              type="button"
              onClick={performRefresh}
              disabled={isRefreshing || isPending}
              className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
            >
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            disabled={isPending || isRefreshing}
            className="px-3 py-1.5 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Scopes */}
      {credential.scopes && (
        <div className="flex flex-wrap gap-1">
          {credential.scopes.split(/\s+/).map((scope) => (
            <span
              key={scope}
              className="px-1.5 py-0.5 bg-neutral-800 text-neutral-400 rounded text-[10px] font-mono"
            >
              {scope}
            </span>
          ))}
        </div>
      )}

      {/* In-use chips */}
      {inUseCount > 0 && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[10px] text-neutral-600 uppercase tracking-wider font-semibold mr-1">
            Used by
          </span>
          {credential.inUseBy.map((u) => (
            <Link
              key={u.connectorId}
              href="/connectors"
              className="px-2 py-0.5 rounded text-[10px] bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors font-mono"
            >
              {u.connectorSlug}
            </Link>
          ))}
        </div>
      )}

      {/* Rename inline form */}
      {renameOpen && (
        <div className="pt-2 border-t border-neutral-800/60 space-y-2">
          <label className="block text-xs text-neutral-500">New display name</label>
          <input
            type="text"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') performRename();
              if (e.key === 'Escape') setRenameOpen(false);
            }}
            autoFocus
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={performRename}
              disabled={isPending}
              className="px-3 py-1.5 text-xs font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setRenameOpen(false);
                setRenameName(credential.name);
              }}
              className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white"
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
