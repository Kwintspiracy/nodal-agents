'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateAuthSettingsAction, type SecurityView } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

interface Props {
  initial: SecurityView;
}

export default function SecurityForm({ initial }: Props) {
  const [mode, setMode] = useState<'local-trust' | 'local-auth'>(initial.configuredMode);
  const [editGoogle, setEditGoogle] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [restartHint, setRestartHint] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const r = await updateAuthSettingsAction({
        mode,
        googleClientId: editGoogle ? (fd.get('googleClientId') as string) : undefined,
        googleClientSecret: editGoogle ? (fd.get('googleClientSecret') as string) : undefined,
        clearGoogle: false,
      });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Auth settings saved');
        setRestartHint(r.data.requiresRestart);
      }
    });
  }

  function performClearGoogle() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await updateAuthSettingsAction({ mode, clearGoogle: true });
      if (!r.ok) toast.error(r.message);
      else toast.success('Google credentials removed');
    });
  }

  const driftFromRuntime = mode !== initial.runtimeMode;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="block text-xs text-neutral-500 mb-2">Auth mode</legend>
        <Choice
          checked={mode === 'local-trust'}
          onChange={() => setMode('local-trust')}
          label="No auth (local-trust)"
          subtitle="Single hardcoded user. Recommended for solo loopback installs."
        />
        <Choice
          checked={mode === 'local-auth'}
          onChange={() => setMode('local-auth')}
          label="Email + password (local-auth)"
          subtitle="Sign-up + login via better-auth. Optional Google OAuth on top."
        />
      </fieldset>

      {mode === 'local-auth' && (
        <div className="bg-neutral-950 border border-neutral-800/40 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-white">Google OAuth</div>
              <div className="text-xs text-neutral-500">
                {initial.googleConfigured
                  ? 'Configured.'
                  : 'Optional. Add to allow Google sign-in alongside email + password.'}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setEditGoogle((v) => !v)}
                className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white"
              >
                {editGoogle ? 'Hide fields' : initial.googleConfigured ? 'Rotate' : 'Add'}
              </button>
              {initial.googleConfigured && (
                <button
                  type="button"
                  onClick={() => setConfirmOpen(true)}
                  disabled={isPending}
                  className="px-3 py-1.5 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {editGoogle && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-neutral-500 mb-1" htmlFor="google-client-id">
                  Client ID
                </label>
                <input
                  id="google-client-id"
                  name="googleClientId"
                  type="text"
                  placeholder="xxx.apps.googleusercontent.com"
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
                />
              </div>
              <div>
                <label
                  className="block text-xs text-neutral-500 mb-1"
                  htmlFor="google-client-secret"
                >
                  Client secret
                </label>
                <input
                  id="google-client-secret"
                  name="googleClientSecret"
                  type="password"
                  placeholder={initial.googleConfigured ? '•••••••• (overwrite)' : ''}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
                />
              </div>
              <p className="sm:col-span-2 text-[11px] text-neutral-600">
                Use authorized JavaScript origins{' '}
                <code className="font-mono">http://localhost:3000</code> and redirect URI{' '}
                <code className="font-mono">http://localhost:3000/api/auth/callback/google</code> in
                the Google Cloud Console.
              </p>
            </div>
          )}
        </div>
      )}

      {!initial.configPathExists && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 text-xs text-amber-300">
          ~/.nodalai/config.json wasn&apos;t found. Save here will fail until you&apos;ve run{' '}
          <code className="font-mono">nodal-agents init</code> at least once.
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
        {driftFromRuntime && (
          <span className="text-xs text-amber-400">
            New mode <code className="font-mono">{mode}</code> requires{' '}
            <code className="font-mono">nodal-agents down && nodal-agents up</code> to take effect.
          </span>
        )}
      </div>

      {restartHint && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3 py-2 text-xs text-emerald-300">
          Saved. Restart with{' '}
          <code className="font-mono">nodal-agents down && nodal-agents up</code> to activate the
          new auth mode.
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title="Remove Google OAuth credentials?"
        message="The clientId and clientSecret will be removed from ~/.nodalai/config.json. Users with active Google sessions will need to sign in again with email + password."
        confirmLabel="Remove"
        onConfirm={performClearGoogle}
        onCancel={() => setConfirmOpen(false)}
      />
    </form>
  );
}

function Choice({
  checked,
  onChange,
  label,
  subtitle,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  subtitle: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 px-3 py-2 rounded-md cursor-pointer border ${
        checked
          ? 'border-violet-500/50 bg-violet-500/5'
          : 'border-neutral-800 hover:border-neutral-700'
      }`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="mt-1 accent-violet-500"
      />
      <div>
        <div className="text-sm text-white">{label}</div>
        <div className="text-xs text-neutral-500">{subtitle}</div>
      </div>
    </label>
  );
}
