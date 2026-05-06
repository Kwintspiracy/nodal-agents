'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  saveApiKeyConnectorAction,
  saveOauthConnectorAction,
  deleteConnectorAction,
  type ConnectorListEntry,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

interface Props {
  entry: ConnectorListEntry;
}

export default function ConnectorForm({ entry }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isApiKey = entry.authType === 'api_key';

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    startTransition(async () => {
      const result = isApiKey
        ? await saveApiKeyConnectorAction({
            slug: entry.catalogSlug,
            apiKey: fd.get('apiKey'),
            name: fd.get('name') || undefined,
          })
        : await saveOauthConnectorAction({
            slug: entry.catalogSlug,
            name: fd.get('name') || undefined,
            oauthClientId: fd.get('oauthClientId'),
            oauthClientSecret: fd.get('oauthClientSecret'),
            oauthRefreshToken: fd.get('oauthRefreshToken'),
            oauthAccessToken: fd.get('oauthAccessToken') || undefined,
            oauthTokenUrl: fd.get('oauthTokenUrl') || undefined,
            oauthScopes: fd.get('oauthScopes') || undefined,
            oauthAccountName: fd.get('oauthAccountName') || undefined,
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

  const status = entry.connector
    ? entry.connector.active
      ? 'connected'
      : 'inactive'
    : 'disconnected';

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-4">
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
          {entry.connector?.oauthAccountName && (
            <p className="text-xs text-neutral-400 mt-1">{entry.connector.oauthAccountName}</p>
          )}
        </div>

        <div className="flex gap-2 shrink-0">
          {entry.connector ? (
            <>
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

      {open && (
        <form onSubmit={handleSubmit} className="space-y-3 pt-2 border-t border-neutral-800/60">
          <div>
            <label className="block text-xs text-neutral-500 mb-1">
              Display name <span className="text-neutral-700">(optional)</span>
            </label>
            <input
              name="name"
              defaultValue={entry.connector?.name ?? ''}
              placeholder={entry.label}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </div>

          {isApiKey ? (
            <div>
              <label className="block text-xs text-neutral-500 mb-1">API key</label>
              <input
                name="apiKey"
                type="password"
                required
                placeholder={entry.connector?.hasApiKey ? '•••••••• (leave blank to keep)' : ''}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-neutral-500 mb-1">Client ID</label>
                  <input
                    name="oauthClientId"
                    required
                    defaultValue={entry.connector?.oauthClientId ?? ''}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-neutral-500 mb-1">Client secret</label>
                  <input
                    name="oauthClientSecret"
                    type="password"
                    required
                    placeholder={
                      entry.connector?.hasOauthRefreshToken ? '•••••••• (overwrite to change)' : ''
                    }
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Refresh token</label>
                <input
                  name="oauthRefreshToken"
                  type="password"
                  required
                  placeholder={
                    entry.connector?.hasOauthRefreshToken ? '•••••••• (overwrite to change)' : ''
                  }
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
                />
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
                  Advanced (token URL, scopes, account name)
                </summary>
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Token URL</label>
                    <input
                      name="oauthTokenUrl"
                      defaultValue={'https://oauth2.googleapis.com/token'}
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Scopes</label>
                    <input
                      name="oauthScopes"
                      defaultValue={entry.connector?.oauthScopes ?? ''}
                      placeholder="space-separated"
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Account name</label>
                    <input
                      name="oauthAccountName"
                      defaultValue={entry.connector?.oauthAccountName ?? ''}
                      placeholder="user@example.com"
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
                    />
                  </div>
                </div>
              </details>
            </>
          )}

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
      <ConfirmDialog
        open={confirmOpen}
        title={`Disconnect ${entry.label}?`}
        message="Tools that depend on this connector will fail until you reconnect. Existing job history is preserved."
        confirmLabel="Disconnect"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
