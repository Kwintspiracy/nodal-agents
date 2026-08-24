'use client';

/**
 * PasswordForm — changer le mot de passe du compte depuis Settings.
 *
 * Avant : mot de passe à changer = retour à l'édition manuelle de la config /
 * de la base. better-auth expose déjà l'endpoint (`/api/auth/change-password`,
 * session requise, vérifie l'ancien mot de passe) — il ne manquait que la
 * surface. Même transport que le formulaire de login (fetch direct vers les
 * endpoints better-auth, pas de client SDK).
 *
 * `revokeOtherSessions: true` : changer son mot de passe est le geste de
 * quelqu'un qui doute — les AUTRES sessions (un téléphone oublié, un
 * navigateur du LAN) sont révoquées ; celle-ci survit.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { SetForm } from '@/components/ui/SetForm.tsx';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import TextInput from '@/components/ui/TextInput';

export default function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);

  function reset() {
    setCurrent('');
    setNext('');
    setConfirm('');
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (next !== confirm) {
      toast.error('New passwords do not match.');
      return;
    }
    // Même plancher que le sign-up (better-auth minPasswordLength par défaut).
    if (next.length < 8) {
      toast.error('New password must be at least 8 characters.');
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: current,
          newPassword: next,
          revokeOtherSessions: true,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        // Le cas de loin le plus courant : l'ancien mot de passe est faux.
        toast.error(
          res.status === 400
            ? (data?.message ?? 'Current password is incorrect.')
            : (data?.message ?? 'Could not change the password.'),
        );
        return;
      }
      reset();
      toast.success('Password changed. Other signed-in devices were signed out.');
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <SetForm>
        <div className="space-y-2">
          <TextInput
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="Current password"
            autoComplete="current-password"
            required
          />
          <TextInput
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="New password (min. 8 characters)"
            autoComplete="new-password"
            required
          />
          <TextInput
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repeat new password"
            autoComplete="new-password"
            required
          />
        </div>
        <SetCtaRow onCancel={reset} pending={pending} saveLabel="Change password" />
      </SetForm>
    </form>
  );
}
