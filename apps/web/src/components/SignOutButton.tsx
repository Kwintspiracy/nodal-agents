'use client';

import { useState } from 'react';
import { SignOut } from '@phosphor-icons/react';

export default function SignOutButton() {
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    try {
      // better-auth /sign-out POST requires JSON Content-Type to invalidate the
      // session row in DB and emit Set-Cookie clearing better-auth.session_token.
      // Without these headers it returns 200 but no-ops.
      const res = await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        console.error('sign-out failed', res.status, await res.text().catch(() => ''));
      }
    } catch (err) {
      console.error('sign-out network error', err);
    }
    // Hard navigation: forces the browser to re-fetch the page with whatever
    // cookies remain (none if better-auth cleared them). router.replace is a
    // soft nav that can keep stale React state mounted in memory.
    window.location.replace('/login');
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={loading}
      data-testid="user-menu-sign-out"
      aria-label="Sign out"
      title="Sign out"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      <SignOut size={15} />
    </button>
  );
}
