'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  deleteConnectorAction,
  renameConnectorAction,
  assignCredentialAction,
  updateConnectorApiKeyAction,
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

  // Rotate-key state (api_key connectors only). Collapsed by default so a
  // sensitive input doesn't sit visible on the page; revealed via a button.
  const [rotateOpen, setRotateOpen] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');

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

  function performRotate() {
    const trimmed = newApiKey.trim();
    if (!trimmed) {
      toast.error('New API key is required');
      return;
    }
    startTransition(async () => {
      const r = await updateConnectorApiKeyAction(instance.id, trimmed);
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
    <div className="bg-paper border border-rule-2 rounded-xl p-5 space-y-4">
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
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-ink truncate">{instance.name}</h3>
              <button
                type="button"
                onClick={() => setIsRenaming(true)}
                aria-label="Rename connector"
                className="text-ink-4 hover:text-ink-3 transition-colors text-xs leading-none"
                title="Rename"
              >
                ✎
              </button>
              <span
                className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                  status === 'connected' ? 'bg-agent-vivid/15 text-ok' : 'bg-warn-bg text-warn'
                }`}
              >
                {status}
              </span>
            </div>
          )}
          <p className="text-xs text-ink-3 mt-1 font-mono">
            {catalogEntry.slug} · {instance.authType}
          </p>
          {connectedAccountName && (
            <p className="text-xs text-ink-3 mt-1">{connectedAccountName}</p>
          )}
          {isApiKey && instance.hasApiKey && (
            <p className="text-xs text-ink-4 mt-0.5 font-mono">
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
                  className="px-3 py-1.5 text-xs font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink disabled:opacity-40"
                >
                  {isRefreshing ? 'Refreshing…' : 'Refresh now'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                disabled={isPending || isRefreshing}
                className="px-3 py-1.5 text-xs font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink disabled:opacity-40"
              >
                Reconnect
              </button>
              {compatibleCredentials.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSwitchOpen((v) => !v)}
                  disabled={isPending || isRefreshing}
                  className="px-3 py-1.5 text-xs font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink disabled:opacity-40"
                >
                  {switchOpen ? 'Cancel' : 'Switch credential'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={isPending || isRefreshing}
                className="px-3 py-1.5 text-xs font-medium border border-err/30 text-err rounded-md hover:border-err/30 hover:text-err disabled:opacity-40"
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setRotateOpen((v) => !v)}
                disabled={isPending}
                className="px-3 py-1.5 text-xs font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink disabled:opacity-40"
              >
                {rotateOpen ? 'Cancel' : 'Rotate key'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={isPending}
                className="px-3 py-1.5 text-xs font-medium border border-err/30 text-err rounded-md hover:border-err/30 hover:text-err disabled:opacity-40"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {/* Rotate API key panel — api_key connectors only.
          Existing assignments to agents are preserved because we update the
          row in place rather than delete + recreate. */}
      {isApiKey && rotateOpen && (
        <div className="space-y-3 pt-2 border-t border-rule-2">
          <div>
            <label htmlFor={`rotate-${instance.id}`} className="block text-xs text-ink-3 mb-1">
              New API key
            </label>
            <input
              id={`rotate-${instance.id}`}
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
              Agent assignments stay intact — only the stored key changes.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <button
              type="button"
              onClick={performRotate}
              disabled={isPending || !newApiKey.trim()}
              className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
            >
              {isPending ? 'Saving…' : 'Save new key'}
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

      {catalogEntry.docsHint && <p className="text-xs text-ink-3">{catalogEntry.docsHint}</p>}

      {/* Connected OAuth status panel */}
      {isOAuth && connectedCredentialId && (
        <div className="pt-2 border-t border-rule-2 space-y-2">
          {connectedCredentialName && (
            <p className="text-xs text-ink-3">
              Credential: <span className="text-ink font-medium">{connectedCredentialName}</span>
            </p>
          )}
          {connectedScopes && (
            <div className="flex flex-wrap gap-1">
              {connectedScopes.split(/\s+/).map((scope) => (
                <span
                  key={scope}
                  className="px-1.5 py-0.5 bg-hover text-ink-3 rounded text-[10px] font-mono"
                >
                  {scope}
                </span>
              ))}
            </div>
          )}
          {supportsRefresh && <p className="text-xs text-ink-3">Auto-refreshes when used</p>}
          {!supportsRefresh && connectedExpiresAt && (
            <p className={`text-xs ${isTokenExpired ? 'text-warn' : 'text-ink-3'}`}>
              {formatTokenExpiry(connectedExpiresAt)}
            </p>
          )}
        </div>
      )}

      {/* Switch credential panel */}
      {isOAuth && switchOpen && (
        <div className="space-y-3 pt-2 border-t border-rule-2">
          {compatibleCredentials.length > 0 ? (
            <>
              <div>
                <label className="block text-xs text-ink-3 mb-1">Use credential</label>
                <select
                  value={selectedCredentialId}
                  onChange={(e) => setSelectedCredentialId(e.target.value)}
                  className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
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
                  className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
                >
                  {isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSwitchOpen(false);
                    setWizardOpen(true);
                  }}
                  className="px-3 py-1.5 text-xs text-ink-3 hover:text-ink underline"
                >
                  or create new
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-ink-3">
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
