import 'server-only';

import { headers } from 'next/headers';
import { ShieldCheck, User } from '@phosphor-icons/react/dist/ssr';
import { users, eq } from '@nodal-agents/db';
import { getDb, requireUserWithEntity } from '@/lib/server.ts';
import { env } from '@/lib/env.ts';
import SignOutButton from './SignOutButton.tsx';

/**
 * Bottom-of-sidebar slot showing who is signed in.
 *
 * - local-auth → email + Sign-out button (better-auth)
 * - local-trust → "Local trust" badge, no sign-out (no real user)
 * - bearer-token → "API token" badge, no sign-out
 *
 * Restyled for the new design-system shell: paper-on-sidebar instead of
 * neutral-900-on-black. Colours respond to the active theme automatically
 * via the design tokens.
 */
export default async function UserMenu() {
  const mode = env.AUTH_MODE;

  if (mode === 'local-trust') {
    return (
      <ModeBadge
        icon={<ShieldCheck weight="fill" className="h-[18px] w-[18px] lg:h-[13px] lg:w-[13px]" />}
        label="Local trust"
        hint="No auth — single-user install"
      />
    );
  }

  if (mode === 'bearer-token') {
    return (
      <ModeBadge
        icon={<ShieldCheck weight="fill" className="h-[18px] w-[18px] lg:h-[13px] lg:w-[13px]" />}
        label="API token"
      />
    );
  }

  // local-auth — fetch email for the current session.
  const email = await getCurrentEmail();
  if (!email) {
    // Should not happen: dashboard layout already gates with requireUserWithEntity.
    return null;
  }

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-rule-2 bg-paper px-3 py-2.5 lg:gap-2 lg:rounded-lg lg:px-2.5 lg:py-2">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-hover text-ink-3 lg:h-7 lg:w-7">
        <User weight="fill" className="h-[18px] w-[18px] lg:h-[13px] lg:w-[13px]" />
      </div>
      <div className="min-w-0 flex-1" data-testid="user-menu-email">
        <p className="truncate text-sm font-medium text-ink lg:text-xs" title={email}>
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
    <div className="flex items-center gap-2.5 rounded-xl border border-rule-2 bg-paper px-3 py-2.5 lg:gap-2 lg:rounded-lg lg:px-2.5 lg:py-2">
      <div className="shrink-0 text-ok">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-tight text-ink lg:text-xs">{label}</p>
        {hint && <p className="mt-0.5 truncate text-[12px] text-ink-3 lg:text-[10px]">{hint}</p>}
      </div>
    </div>
  );
}
