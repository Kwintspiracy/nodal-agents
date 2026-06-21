import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthError, NoEntityError } from '@nodal-agents/auth';
import Sidebar from '@/components/Sidebar';
import UserMenu from '@/components/UserMenu.tsx';
import Topbar from '@/components/ui/Topbar';
import ThemedToaster from '@/components/ui/ThemedToaster';
import { ApprovalsProvider, type PendingApproval } from '@/components/ApprovalsProvider';
import { requireUserWithEntity } from '@/lib/server.ts';
import {
  listWorkspacesAction,
  listApprovalsAction,
  getEntityStatsAction,
  type WorkspaceRow,
} from '@/lib/actions.ts';

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

  // First-run gate: a workspace with NO agents hasn't been set up yet — send it
  // to the dedicated full-screen onboarding flow instead of dumping the user on
  // an empty dashboard. We key off agent count (not LLM provider): in local
  // trust the runner auto-seeds an env-derived LLM key on boot, so "has a
  // provider" is almost always true and useless as a fresh-install signal.
  // "Has at least one agent" is the real "is this set up?" line. Once they
  // create their first agent, onboarding stops triggering.
  // Only gate to onboarding on a SUCCESSFUL "zero agents" read. Do NOT redirect
  // when the stats query fails: defaulting a failed read to 0 would bounce a
  // real workspace into onboarding, and — because the onboarding page redirects
  // back to '/' once it sees agentCount > 0 — an intermittent DB failure (e.g.
  // pool exhaustion right after the onboarding click-through) flip-flops the two
  // reads and produces a '/' <-> '/onboarding' redirect loop (blank screen).
  const freshStats = await getEntityStatsAction();
  if (freshStats.ok && freshStats.data.agentCount === 0) redirect('/onboarding');

  // Fetch workspaces server-side so the Sidebar receives them as a prop.
  // Failure is non-fatal — the sidebar falls back to an empty list.
  let workspaces: WorkspaceRow[] = [];
  const wsResult = await listWorkspacesAction();
  if (wsResult.ok) workspaces = wsResult.data;

  // Seed the approvals context with the current pending list for instant
  // first-paint. Non-fatal — the provider will poll and fill in on next tick.
  let initialPending: PendingApproval[] = [];
  const approvalsResult = await listApprovalsAction({ status: 'pending' });
  if (approvalsResult.ok) {
    initialPending = approvalsResult.data.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      toolName: r.toolName,
      agentName: r.agentName,
      toolInput: r.toolInput,
      requestedAt: r.requestedAt,
    }));
  }

  return (
    <ApprovalsProvider initial={initialPending}>
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
    </ApprovalsProvider>
  );
}
