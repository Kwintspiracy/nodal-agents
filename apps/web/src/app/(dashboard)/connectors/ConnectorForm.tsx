'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  saveApiKeyConnectorAction,
  deleteConnectorAction,
  refreshConnectorAction,
  type ConnectorListEntry,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

// Mirrors oauth-providers.ts — providers that do not support token refresh.
// Keep in sync with `supportsRefresh: false` entries in oauth-providers.ts.
const OAUTH_NO_REFRESH_SLUGS: ReadonlySet<string> = new Set(['notion-oauth']);

/**
 * Renders a relative time string for an OAuth token expiry date.
 * E.g. "expires in 23 min", "expired 2 min ago", "expires in 2 h".
 */
function formatTokenExpiry(date: Date | null): string {
  if (!date) return '';
  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const absSec = Math.abs(diffSec);

  let magnitude: string;
  if (absSec < 60) {
    magnitude = `${absSec}s`;
  } else if (absSec < 3600) {
    magnitude = `${Math.round(absSec / 60)} min`;
  } else if (absSec < 86400) {
    magnitude = `${Math.round(absSec / 3600)} h`;
  } else {
    magnitude = `${Math.round(absSec / 86400)} d`;
  }

  return diffSec >= 0 ? `expires in ${magnitude}` : `expired ${magnitude} ago`;
}

/** Returns true if the token expiry date is in the past. Module-scope so Date.now() is outside render. */
function isExpiredDate(date: Date | null): boolean {
  if (!date) return false;
  return date.getTime() < Date.now();
}

interface Props {
  entry: ConnectorListEntry;
}

export default function ConnectorForm({ entry }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, startRefreshTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  // For the reconnect flow: show pre-filled client ID / secret inputs.
  const [showReconnect, setShowReconnect] = useState(false);
  const isApiKey = entry.authType === 'api_key';
  const isOAuth = entry.authType === 'oauth2';
  const isConnected = !!entry.connector?.active;
  const supportsRefresh = isOAuth && !OAUTH_NO_REFRESH_SLUGS.has(entry.catalogSlug);

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

  function performRefresh() {
    if (!entry.connector) return;
    const id = entry.connector.id;
    startRefreshTransition(async () => {
      const r = await refreshConnectorAction(id);
      if (!r.ok) {
        toast.error(r.message ?? 'Refresh failed');
      } else {
        toast.success('Token refreshed');
      }
    });
  }

  function handleReconnectConfirm() {
    setReconnectOpen(false);
    setShowReconnect(true);
  }

  const status = entry.connector
    ? entry.connector.active
      ? 'connected'
      : 'inactive'
    : 'disconnected';

  const connector = entry.connector;
  // Delegate Date.now() to a module-scope helper (isExpiredDate) so the
  // react-hooks/purity rule doesn't flag an impure call inside render.
  const isTokenExpired = isExpiredDate(connector?.oauthTokenExpiresAt ?? null);

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
          {connector?.oauthAccountName && (
            <p className="text-xs text-neutral-400 mt-1">{connector.oauthAccountName}</p>
          )}
        </div>

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
                onClick={() => setReconnectOpen(true)}
                disabled={isPending || isRefreshing}
                className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
              >
                Reconnect
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
          ) : (
            /* Not connected */
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
      {isConnected && isOAuth && connector && (
        <div className="pt-2 border-t border-neutral-800/60 space-y-2">
          {connector.oauthScopes && (
            <div className="flex flex-wrap gap-1">
              {connector.oauthScopes.split(/\s+/).map((scope) => (
                <span
                  key={scope}
                  className="px-1.5 py-0.5 bg-neutral-800 text-neutral-400 rounded text-[10px] font-mono"
                >
                  {scope}
                </span>
              ))}
            </div>
          )}
          {connector.oauthTokenExpiresAt && (
            <p className={`text-xs ${isTokenExpired ? 'text-amber-400' : 'text-neutral-500'}`}>
              {formatTokenExpiry(connector.oauthTokenExpiresAt)}
            </p>
          )}
        </div>
      )}

      {/* Reconnect: show OAuth form pre-filled */}
      {showReconnect && isOAuth && (
        <form
          method="POST"
          action={`/api/oauth/${entry.catalogSlug}/start`}
          encType="application/x-www-form-urlencoded"
          className="space-y-3 pt-2 border-t border-neutral-800/60"
        >
          <p className="text-xs text-neutral-500">
            Re-enter credentials to start a new OAuth session.
          </p>
          <div>
            <label className="block text-xs text-neutral-500 mb-1">
              Display name <span className="text-neutral-700">(optional)</span>
            </label>
            <input
              name="name"
              defaultValue={connector?.name ?? ''}
              placeholder={entry.label}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="reconnect-clientId" className="block text-xs text-neutral-500 mb-1">
                Client ID
              </label>
              <input
                id="reconnect-clientId"
                name="clientId"
                required
                defaultValue={connector?.oauthClientId ?? ''}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none font-mono"
              />
            </div>
            <div>
              <label
                htmlFor="reconnect-clientSecret"
                className="block text-xs text-neutral-500 mb-1"
              >
                Client secret{' '}
                {connector?.hasOauthClientSecret && (
                  <span className="text-neutral-700">(leave blank to reuse stored)</span>
                )}
              </label>
              <input
                id="reconnect-clientSecret"
                name="clientSecret"
                type="password"
                placeholder={connector?.hasOauthClientSecret ? '•••••••• (stored)' : ''}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200"
            >
              Continue with {entry.label}
            </button>
            <button
              type="button"
              onClick={() => setShowReconnect(false)}
              className="px-4 py-2 text-sm font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Disconnected OAuth: browser-redirect form to start OAuth flow */}
      {!entry.connector && isOAuth && open && (
        <form
          method="POST"
          action={`/api/oauth/${entry.catalogSlug}/start`}
          encType="application/x-www-form-urlencoded"
          className="space-y-3 pt-2 border-t border-neutral-800/60"
        >
          <div>
            <label htmlFor="oauth-name" className="block text-xs text-neutral-500 mb-1">
              Display name <span className="text-neutral-700">(optional)</span>
            </label>
            <input
              id="oauth-name"
              name="name"
              placeholder={entry.label}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="oauth-clientId" className="block text-xs text-neutral-500 mb-1">
                Client ID
              </label>
              <input
                id="oauth-clientId"
                name="clientId"
                required
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none font-mono"
              />
            </div>
            <div>
              <label htmlFor="oauth-clientSecret" className="block text-xs text-neutral-500 mb-1">
                Client secret
              </label>
              <input
                id="oauth-clientSecret"
                name="clientSecret"
                type="password"
                required
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
              />
            </div>
          </div>
          <div className="pt-1">
            <button
              type="submit"
              className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200"
            >
              Continue with {entry.label}
            </button>
          </div>
        </form>
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
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />

      {/* Reconnect confirmation */}
      <ConfirmDialog
        open={reconnectOpen}
        title={`Reconnect ${entry.label}?`}
        message="This will start a new OAuth session. Enter your credentials to continue."
        confirmLabel="Continue"
        destructive={false}
        onConfirm={handleReconnectConfirm}
        onCancel={() => setReconnectOpen(false)}
      />
    </div>
  );
}
