'use client';

import { useState } from 'react';
import { SignOut } from '@phosphor-icons/react';
import IconButton from '@/components/ui/IconButton';

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
    <IconButton
      ghost
      onClick={handleSignOut}
      disabled={loading}
      data-testid="user-menu-sign-out"
      aria-label="Sign out"
      title="Sign out"
      className="h-10 w-10 rounded-lg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 lg:h-8 lg:w-8 lg:rounded-md"
    >
      <SignOut size={15} className="h-[18px] w-[18px] lg:h-[15px] lg:w-[15px]" />
    </IconButton>
  );
}
