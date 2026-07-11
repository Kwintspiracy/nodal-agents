import type { ChannelAllowedConversationView } from '@/lib/actions.ts';
import Banner from '@/components/ui/Banner.tsx';
import WhatsAppConfigForm from './WhatsAppConfigForm.tsx';
import ChannelAllowlist from './ChannelAllowlist.tsx';

/**
 * WhatsApp's card in the Channels grid — same shell Telegram/Discord/Slack
 * use, but the connect flow is a QR pairing (WhatsAppConfigForm) instead of a
 * pasted token, and it opens with a warning banner: Baileys (WhatsApp Web)
 * is an unofficial bridge, unlike the other three channels' official bot
 * APIs.
 */
export default function WhatsAppChannelCard({
  agentId,
  agentSlug,
  status,
  allowedConversations,
}: {
  agentId: string;
  agentSlug: string;
  status: 'connected' | 'disconnected';
  allowedConversations: ChannelAllowedConversationView[];
}) {
  return (
    <div className="bg-paper border border-rule-2 rounded-xl px-5 py-5 space-y-5">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand svg, same convention as ConnectorsInstalledTable */}
        <img
          src="/channel-icons/whatsapp.svg"
          alt=""
          aria-hidden="true"
          className="h-9 w-9 shrink-0"
        />
        <div>
          <p className="text-sm font-medium text-ink">WhatsApp</p>
          <p className="text-xs text-ink-3">
            Talk to <span className="font-mono text-ink-2">{agentSlug}</span> from WhatsApp — pairs
            by scanning a QR code, no bot token needed.
          </p>
        </div>
      </div>

      <Banner variant="warn" title="Unofficial method (WhatsApp Web bridge)">
        Small risk of account restriction — prefer a dedicated number, not your main one.
      </Banner>

      <WhatsAppConfigForm agentId={agentId} initialStatus={status} />

      {status === 'connected' && (
        <ChannelAllowlist agentId={agentId} chats={allowedConversations} />
      )}
    </div>
  );
}
