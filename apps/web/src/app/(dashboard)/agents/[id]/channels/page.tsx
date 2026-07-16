import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Channels moved from its own page into a real in-page tab on the agent
 * composer (Quentin's correction: one canonical surface, no extra navigation
 * hop). This route is kept as a redirect so old links (onboarding's
 * per-channel anchors, the agents list row action, bookmarks) don't 404 —
 * same pattern as the old /telegram → /channels redirect this route itself
 * replaced.
 *
 * A hash fragment (e.g. `#telegram` from the onboarding flow) is not sent to
 * the server, but browsers carry it over onto the redirect target when that
 * target has no fragment of its own — the channel cards still render with
 * matching `id="telegram"` / `id="discord"` / … inside the Channels tab, so
 * the anchor scroll still lands on the right card.
 */
export default async function AgentChannelsRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/agents/${id}/edit?tab=channels`);
}
