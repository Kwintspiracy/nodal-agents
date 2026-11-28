import type { ConnectionState } from '@nodal-agents/shared';
import ConnectionStatusPill from '@/components/ConnectionStatusPill.tsx';

/**
 * The state of a channel's link as the runner last learnt it, on every
 * channel's card: a token the platform refused, a session logged out, a
 * platform it could not reach. Shown for a connected channel whose link is
 * not working; nothing when it works, the card already says connected.
 */
export default function ChannelLinkStatus({
  connected,
  link,
}: {
  connected: boolean;
  link: ConnectionState;
}) {
  if (!connected || link.state === 'working') return null;
  return (
    <div className="mt-2" data-channel-link={link.state}>
      <ConnectionStatusPill connection={link} withReason />
    </div>
  );
}
