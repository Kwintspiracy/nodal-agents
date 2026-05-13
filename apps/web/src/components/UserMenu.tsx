import 'server-only';

import { headers } from 'next/headers';
import { ShieldCheck, User } from '@phosphor-icons/react/dist/ssr';
import { users, eq } from '@nodalai/db';
import { getDb, requireUserWithEntity } from '@/lib/server.ts';
import { env } from '@/lib/env.ts';
import SignOutButton from './SignOutButton.tsx';

/**
 * Bottom-of-sidebar slot showing who is signed in.
 *
 * - local-auth → email + Sign-out button (better-auth)
 * - local-trust → "Local trust" badge, no sign-out (no real user)
 * - bearer-token → "API token" badge, no sign-out
 */
export default async function UserMenu() {
  const mode = env.AUTH_MODE;

  if (mode === 'local-trust') {
    return (
      <ModeBadge
        icon={<ShieldCheck size={13} weight="fill" />}
        label="Local trust"
        hint="No auth — single-user install"
      />
    );
  }

  if (mode === 'bearer-token') {
    return <ModeBadge icon={<ShieldCheck size={13} weight="fill" />} label="API token" />;
  }

  // local-auth — fetch email for the current session.
  const email = await getCurrentEmail();
  if (!email) {
    // Should not happen: dashboard layout already gates with requireUserWithEntity.
    return null;
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-neutral-900/40 border border-neutral-800/50">
      <div className="shrink-0 w-7 h-7 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-400">
        <User size={13} weight="fill" />
      </div>
      <div className="flex-1 min-w-0" data-testid="user-menu-email">
        <p className="text-xs text-white font-medium truncate" title={email}>
          {email}
        </p>
      </div>
      <SignOutButton />
    </div>
  );
}

async function getCurrentEmail(): Promise<string | null> {
  try {
    const h = await headers();
    const req = new Request('http://localhost/', { headers: h });
    const session = await requireUserWithEntity(req);
    const row = await getDb()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    return row[0]?.email ?? null;
  } catch {
    return null;
  }
}

function ModeBadge({ icon, label, hint }: { icon: React.ReactNode; label: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-neutral-900/40 border border-neutral-800/50">
      <div className="shrink-0 text-emerald-500">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-white font-medium leading-tight">{label}</p>
        {hint && <p className="text-[10px] text-neutral-500 mt-0.5 truncate">{hint}</p>}
      </div>
    </div>
  );
}
