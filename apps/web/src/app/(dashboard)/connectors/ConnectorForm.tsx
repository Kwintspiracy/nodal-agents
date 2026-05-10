'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  saveApiKeyConnectorAction,
  deleteConnectorAction,
  assignCredentialAction,
  createOrAssignOAuthConnectorAction,
  type ConnectorListEntry,
} from '@/lib/actions.ts';
import { refreshCredentialAction } from '@/lib/credentials.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import CredentialWizard, { type CredentialWizardType } from '../credentials/CredentialWizard.tsx';
import type { CatalogEntry } from '@/lib/connector-catalog.ts';
import HelpSteps from '@/components/HelpSteps.tsx';
import { APIKEY_GUIDES } from '@/lib/connector-help.ts';

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
  entry: ConnectorListEntry;
  /** OAuth credentials compatible with this connector's credentialType. Empty for api_key connectors. */
  compatibleCredentials: CompatibleCredential[];
  catalogEntry: CatalogEntry;
}

export default function ConnectorForm({ entry, compatibleCredentials, catalogEntry }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, startRefreshTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>(
    entry.connector?.credentialId ?? compatibleCredentials[0]?.id ?? '',
  );

  const isApiKey = entry.authType === 'api_key';
  const isOAuth = entry.authType === 'oauth2';
  const isConnected = !!entry.connector?.active;
  const supportsRefresh = isOAuth && !OAUTH_NO_REFRESH_SLUGS.has(catalogEntry.credentialType ?? '');
  const credentialType = catalogEntry.credentialType as CredentialWizardType | undefined;

  // Currently-active credential metadata (from the connector row fields).
  const connectedCredentialId = entry.connector?.credentialId ?? null;
  const connectedCredentialName = entry.connector?.credentialName ?? null;
  const connectedAccountName = entry.connector?.credentialAccountName ?? null;
  const connectedExpiresAt = entry.connector?.credentialExpiresAt ?? null;
  const connectedScopes = entry.connector?.credentialScopes ?? null;
  const isTokenExpired = isExpiredDate(connectedExpiresAt);

  const status = entry.connector
    ? entry.connector.active
      ? 'connected'
      : 'inactive'
    : 'disconnected';

  function handleApiKeySubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    startTransition(async () => {
      const result = await saveApiKeyConnectorAction({
        slug: entry.catalogSlug,
        apiKey: fd.get('apiKey'),
        name: fd.get('name') || undefined,
      });

      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`${entry.label} connected`);
      setOpen(false);
    });
  }

  function performDelete() {
    setConfirmOpen(false);
    if (!entry.connector) return;
    const id = entry.connector.id;
    startTransition(async () => {
      const r = await deleteConnectorAction(id);
      if (!r.ok) toast.error(r.message);
      else toast.success(`${entry.label} disconnected`);
    });
  }

  function performAssign(credentialId: string) {
    startTransition(async () => {
      // First-time connect (no connector row yet) → upsert to create the row.
      // Existing connector → assignCredentialAction (cheaper, no INSERT path).
      const r = entry.connector
        ? await assignCredentialAction(entry.connector.id, credentialId)
        : await createOrAssignOAuthConnectorAction(entry.catalogSlug, credentialId);

      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(
        entry.connector ? `${entry.label} credential updated` : `${entry.label} connected`,
      );
      setOpen(false);
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

  function performDisconnect() {
    setConfirmOpen(false);
    if (!entry.connector) return;
    const id = entry.connector.id;
    startTransition(async () => {
      const r = await deleteConnectorAction(id);
      if (!r.ok) toast.error(r.message);
      else toast.success(`${entry.label} disconnected`);
    });
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-white">{entry.label}</h3>
            <span
              className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                status === 'connected'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : status === 'inactive'
                    ? 'bg-amber-500/15 text-amber-400'
                    : 'bg-neutral-800 text-neutral-500'
              }`}
            >
              {status}
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-1 font-mono">
            {entry.catalogSlug} · {entry.authType}
          </p>
          {connectedAccountName && (
            <p className="text-xs text-neutral-400 mt-1">{connectedAccountName}</p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 shrink-0 flex-wrap justify-end">
          {isConnected && isOAuth ? (
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
              {/* Switch credential dropdown */}
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                disabled={isPending || isRefreshing}
                className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
              >
                {open ? 'Cancel' : 'Switch credential'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={isPending || isRefreshing}
                className="px-3 py-1.5 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
              >
                Disconnect
              </button>
            </>
          ) : entry.connector ? (
            <>
              {/* api_key connected — show Edit / Disconnect */}
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white"
              >
                {open ? 'Cancel' : 'Edit'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={isPending}
                className="px-3 py-1.5 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
              >
                Disconnect
              </button>
            </>
          ) : isOAuth ? (
            /* OAuth not connected */
            compatibleCredentials.length === 0 ? (
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                className="px-3 py-1.5 text-xs font-semibold bg-white text-black rounded-md hover:bg-neutral-200"
              >
                Connect with{' '}
                {catalogEntry.credentialType
                  ? (PROVIDER_LABEL[catalogEntry.credentialType] ?? entry.label)
                  : entry.label}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="px-3 py-1.5 text-xs font-semibold bg-white text-black rounded-md hover:bg-neutral-200"
              >
                {open ? 'Cancel' : 'Connect'}
              </button>
            )
          ) : (
            /* api_key not connected */
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="px-3 py-1.5 text-xs font-semibold bg-white text-black rounded-md hover:bg-neutral-200"
            >
              {open ? 'Cancel' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-neutral-500">{entry.docsHint}</p>

      {/* Connected OAuth status panel */}
      {isConnected && isOAuth && connectedCredentialId && (
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
          {connectedExpiresAt && (
            <p
              className={`text-xs ${
                // Amber alarm only when the token is expired AND the provider can NOT
                // self-refresh (e.g. Notion). Refreshable providers auto-renew on use,
                // so showing an alarmist "expired" badge is misleading there.
                isTokenExpired && !supportsRefresh ? 'text-amber-400' : 'text-neutral-500'
              }`}
            >
              {supportsRefresh && isTokenExpired
                ? 'Auto-refreshes when used'
                : formatTokenExpiry(connectedExpiresAt)}
            </p>
          )}
        </div>
      )}

      {/* OAuth — switch credential or connect with existing */}
      {isOAuth && open && (
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
                  onClick={() => setWizardOpen(true)}
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
                  setOpen(false);
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

      {/* api_key connect/edit form */}
      {isApiKey && open && (
        <form
          onSubmit={handleApiKeySubmit}
          className="space-y-3 pt-2 border-t border-neutral-800/60"
        >
          <div>
            <label htmlFor="apikey-name" className="block text-xs text-neutral-500 mb-1">
              Display name <span className="text-neutral-700">(optional)</span>
            </label>
            <input
              id="apikey-name"
              name="name"
              defaultValue={entry.connector?.name ?? ''}
              placeholder={entry.label}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </div>
          {APIKEY_GUIDES[entry.catalogSlug as keyof typeof APIKEY_GUIDES] && (
            <details className="group text-xs">
              <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
                Where do I get this?
              </summary>
              <div className="mt-3 pl-1">
                <HelpSteps guide={APIKEY_GUIDES[entry.catalogSlug as keyof typeof APIKEY_GUIDES]} />
              </div>
            </details>
          )}
          <div>
            <label htmlFor="apikey-apiKey" className="block text-xs text-neutral-500 mb-1">
              API key
            </label>
            <input
              id="apikey-apiKey"
              name="apiKey"
              type="password"
              required
              placeholder={entry.connector?.hasApiKey ? '•••••••• (leave blank to keep)' : ''}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
            />
          </div>
          <div className="pt-1">
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
            >
              {isPending ? 'Saving…' : entry.connector ? 'Update' : 'Connect'}
            </button>
          </div>
        </form>
      )}

      {/* Disconnect confirmation */}
      <ConfirmDialog
        open={confirmOpen}
        title={`Disconnect ${entry.label}?`}
        message="Tools that depend on this connector will fail until you reconnect. Existing job history is preserved."
        confirmLabel="Disconnect"
        onConfirm={isOAuth ? performDisconnect : performDelete}
        onCancel={() => setConfirmOpen(false)}
      />

      {/* Credential wizard modal */}
      {wizardOpen && credentialType && (
        <CredentialWizard
          initialType={credentialType}
          returnToConnectorSlug={entry.catalogSlug}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </div>
  );
}

/** Human-friendly label for each credential type, used in button text. */
const PROVIDER_LABEL: Record<string, string> = {
  'google-oauth': 'Google',
  'notion-oauth': 'Notion',
  'airtable-oauth': 'Airtable',
};
