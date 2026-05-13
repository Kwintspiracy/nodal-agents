'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SignOut } from '@phosphor-icons/react';

export default function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST' });
    } catch {
      // Cookie already invalid client-side either way — proceed to redirect.
    }
    router.replace('/login');
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={loading}
      data-testid="user-menu-sign-out"
      aria-label="Sign out"
      title="Sign out"
      className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md text-neutral-500 hover:text-white hover:bg-neutral-800/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <SignOut size={15} />
    </button>
  );
}
