'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateAuthSettingsAction, type SecurityView } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import { OptionRadio } from '@/components/ui/OptionRadio.tsx';
import Banner from '@/components/ui/Banner';
import { SetMini } from '@/components/ui/SetMini.tsx';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import { SetForm } from '@/components/ui/SetForm.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import TextInput from '@/components/ui/TextInput';
import FieldLabel from '@/components/ui/FieldLabel';

interface Props {
  initial: SecurityView;
}

export default function SecurityForm({ initial }: Props) {
  const [mode, setMode] = useState<'local-trust' | 'local-auth'>(initial.configuredMode);
  const [editGoogle, setEditGoogle] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restartHint, setRestartHint] = useState(false);

  function handleReset() {
    setMode(initial.configuredMode);
    setEditGoogle(false);
    setRestartHint(false);
  }

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

  return (
    <form onSubmit={handleSubmit}>
      <SetForm label="Auth mode">
        <OptionRadio
          active={mode === 'local-trust'}
          onClick={() => setMode('local-trust')}
          name="No auth (local-trust)"
          description="Single hardcoded user. Recommended for solo loopback installs."
        />
        <OptionRadio
          active={mode === 'local-auth'}
          onClick={() => setMode('local-auth')}
          name="Email + password (local-auth)"
          description="Sign-up + login via better-auth. Optional Google OAuth on top."
        />

        {mode === 'local-auth' && (
          <>
            <Banner variant="info">
              Each user signs in with email + password. Sessions are stored in the local DB and can
              be revoked from this page.
            </Banner>

            <SetMini
              name="Google OAuth"
              description={
                initial.googleConfigured
                  ? 'Configured.'
                  : 'Optional. Add to allow Google sign-in alongside email + password.'
              }
              action={
                <div className="flex gap-2">
                  <RowActionButton onClick={() => setEditGoogle((v) => !v)}>
                    {editGoogle ? 'Hide fields' : initial.googleConfigured ? 'Rotate' : 'Add'}
                  </RowActionButton>
                  {initial.googleConfigured && (
                    <RowActionButton
                      tone="danger"
                      onClick={() => setConfirmOpen(true)}
                      disabled={isPending}
                    >
                      Remove
                    </RowActionButton>
                  )}
                </div>
              }
            />

            {editGoogle && (
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 px-1">
                <div>
                  <FieldLabel htmlFor="google-client-id">Client ID</FieldLabel>
                  <TextInput
                    id="google-client-id"
                    name="googleClientId"
                    type="text"
                    placeholder="xxx.apps.googleusercontent.com"
                    className="font-mono"
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="google-client-secret">Client secret</FieldLabel>
                  <TextInput
                    id="google-client-secret"
                    name="googleClientSecret"
                    type="password"
                    placeholder={initial.googleConfigured ? '•••••••• (overwrite)' : ''}
                    className="font-mono"
                  />
                </div>
                <p className="sm:col-span-2 text-body-12 text-ink-4">
                  Use authorized JavaScript origins{' '}
                  <code className="font-mono">http://localhost:3000</code> and redirect URI{' '}
                  <code className="font-mono">http://localhost:3000/api/auth/callback/google</code>{' '}
                  in the Google Cloud Console.
                </p>
              </div>
            )}
          </>
        )}

        {!initial.configPathExists && (
          <Banner variant="warn">
            <b className="block font-medium text-ink">Config file missing</b>
            ~/.nodalai/config.json wasn&apos;t found. Save will fail until you&apos;ve run{' '}
            <code className="text-mono-12">nodal-agents init</code> at least once.
          </Banner>
        )}

        <Banner variant="warn">
          <span>
            <b className="block font-medium text-ink">Switching auth mode signs everyone out</b>
            Active sessions are invalidated when the auth mode changes. Make sure you can still sign
            in with the new method before applying.
          </span>
        </Banner>

        {restartHint && (
          <Banner variant="info" title="Saved. Restart required.">
            Run <code className="text-mono-12">nodal-agents down && nodal-agents up</code>{' '}
            to activate the new auth mode.
          </Banner>
        )}

        <SetCtaRow onCancel={handleReset} pending={isPending} />
      </SetForm>

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
