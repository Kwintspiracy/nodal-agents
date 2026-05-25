'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  deleteConnectorAction,
  renameConnectorAction,
  assignCredentialAction,
  type ConnectorRow,
  type ConnectorCatalogItem,
} from '@/lib/actions.ts';
import { refreshCredentialAction } from '@/lib/credentials.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import CredentialWizard, { type CredentialWizardType } from '../credentials/CredentialWizard.tsx';

/** Credential types that do not support access-token refresh (Notion). */
const OAUTH_NO_REFRESH_SLUGS: ReadonlySet<string> = new Set(['notion-oauth']);

/**
 * Renders a relative time string for an OAuth token expiry date.
 */
function formatTokenExpiry(date: Date | null): string {
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

function isExpiredDate(date: Date | null): boolean {
  if (!date) return false;
  return date.getTime() < Date.now();
}

export type CompatibleCredential = {
  id: string;
  name: string;
  accountName: string | null;
};

interface Props {
  instance: ConnectorRow;
  catalogEntry: ConnectorCatalogItem;
  /** OAuth credentials compatible with this connector's credentialType. Empty for api_key connectors. */
  compatibleCredentials: CompatibleCredential[];
}

export default function ConnectorForm({ instance, catalogEntry, compatibleCredentials }: Props) {
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, startRefreshTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  // Rename state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(instance.name);

  // Switch credential state
  const [switchOpen, setSwitchOpen] = useState(false);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>(
    instance.credentialId ?? compatibleCredentials[0]?.id ?? '',
  );

  const isApiKey = instance.authType === 'api_key';
  const isOAuth = instance.authType === 'oauth2';
  const isConnected = instance.active;
  const supportsRefresh = isOAuth && !OAUTH_NO_REFRESH_SLUGS.has(catalogEntry.credentialType ?? '');
  const credentialType = catalogEntry.credentialType as CredentialWizardType | undefined;

  const connectedCredentialId = instance.credentialId;
  const connectedCredentialName = instance.credentialName;
  const connectedAccountName = instance.credentialAccountName;
  const connectedExpiresAt = instance.credentialExpiresAt;
  const connectedScopes = instance.credentialScopes;
  const isTokenExpired = isExpiredDate(connectedExpiresAt ?? null);

  const status: 'connected' | 'inactive' = isConnected ? 'connected' : 'inactive';

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteConnectorAction(instance.id);
      if (!r.ok) toast.error(r.message);
      else toast.success(`${instance.name} removed`);
    });
  }

  function performRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === instance.name) {
      setIsRenaming(false);
      return;
    }
    startTransition(async () => {
      const r = await renameConnectorAction(instance.id, trimmed);
      if (!r.ok) {
        toast.error(r.message);
      } else {
        toast.success('Renamed');
        setIsRenaming(false);
      }
    });
  }

  function performAssign(credentialId: string) {
    startTransition(async () => {
      const r = await assignCredentialAction(instance.id, credentialId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${instance.name} credential updated`);
      setSwitchOpen(false);
    });
  }

  function performRefresh() {
    if (!connectedCredentialId) return;
    startRefreshTransition(async () => {
      const r = await refreshCredentialAction(connectedCredentialId);
      if (!r.ok) {
        toast.error(r.message ?? 'Refresh failed');
      } else {
        toast.success('Token refreshed');
      }
    });
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-4">
      {/* Header row */}
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
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-white truncate">{instance.name}</h3>
              <button
                type="button"
                onClick={() => setIsRenaming(true)}
                aria-label="Rename connector"
                className="text-neutral-600 hover:text-neutral-400 transition-colors text-xs leading-none"
                title="Rename"
              >
                ✎
              </button>
              <span
                className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                  status === 'connected'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-amber-500/15 text-amber-400'
                }`}
              >
                {status}
              </span>
            </div>
          )}
          <p className="text-xs text-neutral-500 mt-1 font-mono">
            {catalogEntry.slug} · {instance.authType}
          </p>
          {connectedAccountName && (
            <p className="text-xs text-neutral-400 mt-1">{connectedAccountName}</p>
          )}
          {isApiKey && instance.hasApiKey && (
            <p className="text-xs text-neutral-600 mt-0.5 font-mono">
              key: …{instance.credentialId ?? '????'}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 shrink-0 flex-wrap justify-end items-start">
          {isOAuth ? (
            <>
              {supportsRefresh && (
                <button
                  type="button"
                  onClick={performRefresh}
                  disabled={isRefreshing || isPending}
                  className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
                >
                  {isRefreshing ? 'Refreshing…' : 'Refresh now'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                disabled={isPending || isRefreshing}
                className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
              >
                Reconnect
              </button>
              {compatibleCredentials.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSwitchOpen((v) => !v)}
                  disabled={isPending || isRefreshing}
                  className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
                >
                  {switchOpen ? 'Cancel' : 'Switch credential'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={isPending || isRefreshing}
                className="px-3 py-1.5 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={isPending}
              className="px-3 py-1.5 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {catalogEntry.docsHint && <p className="text-xs text-neutral-500">{catalogEntry.docsHint}</p>}

      {/* Connected OAuth status panel */}
      {isOAuth && connectedCredentialId && (
        <div className="pt-2 border-t border-neutral-800/60 space-y-2">
          {connectedCredentialName && (
            <p className="text-xs text-neutral-400">
              Credential: <span className="text-white font-medium">{connectedCredentialName}</span>
            </p>
          )}
          {connectedScopes && (
            <div className="flex flex-wrap gap-1">
              {connectedScopes.split(/\s+/).map((scope) => (
                <span
                  key={scope}
                  className="px-1.5 py-0.5 bg-neutral-800 text-neutral-400 rounded text-[10px] font-mono"
                >
                  {scope}
                </span>
              ))}
            </div>
          )}
          {supportsRefresh && <p className="text-xs text-neutral-500">Auto-refreshes when used</p>}
          {!supportsRefresh && connectedExpiresAt && (
            <p className={`text-xs ${isTokenExpired ? 'text-amber-400' : 'text-neutral-500'}`}>
              {formatTokenExpiry(connectedExpiresAt)}
            </p>
          )}
        </div>
      )}

      {/* Switch credential panel */}
      {isOAuth && switchOpen && (
        <div className="space-y-3 pt-2 border-t border-neutral-800/60">
          {compatibleCredentials.length > 0 ? (
            <>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Use credential</label>
                <select
                  value={selectedCredentialId}
                  onChange={(e) => setSelectedCredentialId(e.target.value)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none"
                >
                  {compatibleCredentials.map((cred) => (
                    <option key={cred.id} value={cred.id}>
                      {cred.name}
                      {cred.accountName ? ` (${cred.accountName})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 items-center pt-1">
                <button
                  type="button"
                  onClick={() => selectedCredentialId && performAssign(selectedCredentialId)}
                  disabled={isPending || !selectedCredentialId}
                  className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
                >
                  {isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSwitchOpen(false);
                    setWizardOpen(true);
                  }}
                  className="px-3 py-1.5 text-xs text-neutral-500 hover:text-white underline"
                >
                  or create new
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-neutral-500">
              No compatible credentials found.{' '}
              <button
                type="button"
                onClick={() => {
                  setSwitchOpen(false);
                  setWizardOpen(true);
                }}
                className="text-indigo-400 hover:text-indigo-300 underline"
              >
                Create one
              </button>
            </p>
          )}
        </div>
      )}

      {/* Delete / Disconnect confirmation */}
      <ConfirmDialog
        open={confirmOpen}
        title={`${isOAuth ? 'Disconnect' : 'Delete'} "${instance.name}"?`}
        message={
          isOAuth
            ? 'Tools that depend on this connector will fail until you reconnect. Existing job history is preserved.'
            : 'This connector instance will be permanently removed. Existing job history is preserved.'
        }
        confirmLabel={isOAuth ? 'Disconnect' : 'Delete'}
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />

      {/* Credential wizard modal */}
      {wizardOpen && credentialType && (
        <CredentialWizard
          initialType={credentialType}
          returnToConnectorSlug={catalogEntry.slug}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </div>
  );
}
