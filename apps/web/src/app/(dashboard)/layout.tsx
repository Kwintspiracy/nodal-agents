import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Toaster } from 'sonner';
import { AuthError, NoEntityError } from '@nodal-agents/auth';
import Sidebar from '@/components/Sidebar';
import UserMenu from '@/components/UserMenu.tsx';
import { requireUserWithEntity } from '@/lib/server.ts';

// Gate every dashboard route. The proxy only checks cookie *presence*,
// so a stale/invalidated cookie (DB reset, expired session) reaches the
// dashboard, every action throws AuthError, and the user sees "Failed
// to load X" instead of being sent back to /login. Validate here.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  try {
    const h = await headers();
    const req = new Request('http://localhost/', { headers: h });
    await requireUserWithEntity(req);
  } catch (err) {
    if (err instanceof AuthError) redirect('/login');
    if (err instanceof NoEntityError) redirect('/onboarding');
    throw err;
  }

  return (
    <>
      <Sidebar userMenu={<UserMenu />} />
      {/*
        Canonical viewport width for every dashboard page.

        `max-w-6xl` lives HERE so every page has the same horizontal bounds
        — without it, individual pages each hardcoded their own
        `max-w-2xl|3xl|4xl|5xl|6xl`, producing visually inconsistent column
        widths across the dashboard. Left-aligned (no `mx-auto`) so the
        column hugs the sidebar — matches what the dashboard looked like
        before, with the bonus of uniform width. Page-level wrappers must
        NOT add their own `max-w-*` anymore. Forms or other inner blocks
        that need to be narrower can constrain themselves on the <form>.
      */}
      <main className="flex-1 w-full lg:ml-56 pt-[72px] lg:pt-4 p-3 sm:p-5 lg:p-8 min-w-0">
        <div className="max-w-6xl">{children}</div>
      </main>
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </>
  );
}
