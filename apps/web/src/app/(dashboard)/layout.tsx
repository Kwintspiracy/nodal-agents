import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthError, NoEntityError } from '@nodal-agents/auth';
import Sidebar from '@/components/Sidebar';
import UserMenu from '@/components/UserMenu.tsx';
import Topbar from '@/components/ui/Topbar';
import ThemedToaster from '@/components/ui/ThemedToaster';
import { requireUserWithEntity } from '@/lib/server.ts';
import { listWorkspacesAction, type WorkspaceRow } from '@/lib/actions.ts';

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

  // Fetch workspaces server-side so the Sidebar receives them as a prop.
  // Failure is non-fatal — the sidebar falls back to an empty list.
  let workspaces: WorkspaceRow[] = [];
  const wsResult = await listWorkspacesAction();
  if (wsResult.ok) workspaces = wsResult.data;

  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      <Sidebar workspaces={workspaces} userMenu={<UserMenu />} />

      {/*
        Main pane sits next to the 220px sidebar on desktop and accounts for
        the mobile top bar (h-[58px]) when narrower. The Topbar is rendered
        once per visit at the dashboard level — pages compose their own
        content underneath. Canonical max-width is set on the inner wrapper.
      */}
      <main className="flex min-w-0 flex-1 flex-col pt-[58px] lg:ml-[220px] lg:pt-0">
        <Topbar />
        <div className="flex-1 overflow-x-hidden">
          <div className="max-w-6xl px-5 pb-10 sm:px-8 lg:px-9">{children}</div>
        </div>
      </main>

      <ThemedToaster />
    </div>
  );
}
