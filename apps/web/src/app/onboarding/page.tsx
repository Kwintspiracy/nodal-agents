import OnboardingFlow from './OnboardingFlow.tsx';

export const dynamic = 'force-dynamic';

/**
 * /onboarding — dedicated full-screen first-run flow.
 *
 * Lives OUTSIDE the (dashboard) route group, so it gets none of the dashboard
 * chrome (no sidebar, no topbar, no stats). The ENTRY gate lives in the
 * dashboard layout (a fresh, agent-less workspace is redirected here).
 *
 * This page deliberately does NOT redirect away when an agent exists. It used
 * to (`if agentCount > 0 redirect('/')`), but that caused the success step to
 * be skipped: creating the agent is a Server Action, which makes Next re-render
 * the current route's server components — this page then saw agentCount > 0 and
 * redirected to the dashboard mid-flow, before the "agent is ready" screen +
 * entrance animation could show. The flow itself navigates to the dashboard
 * when the user clicks through the final step.
 */
export default function OnboardingPage() {
  return <OnboardingFlow />;
}
