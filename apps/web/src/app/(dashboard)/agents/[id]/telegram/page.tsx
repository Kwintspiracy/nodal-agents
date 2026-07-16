import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * S4: the Telegram-only config page moved to /agents/[id]/channels (one card
 * per messaging platform), which itself later moved into the Channels tab of
 * /agents/[id]/edit. This route is kept as a redirect — straight to the
 * final destination, not chained through the now-also-a-redirect /channels
 * route — so old links (onboarding, the agents list row action, bookmarks)
 * don't 404.
 */
export default async function AgentTelegramRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/agents/${id}/edit?tab=channels`);
}
