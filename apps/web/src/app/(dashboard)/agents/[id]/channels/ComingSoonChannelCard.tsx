type ComingSoonChannel = 'slack' | 'whatsapp';

const ICON: Record<ComingSoonChannel, string> = {
  slack: '💼',
  whatsapp: '📱',
};

const LABEL: Record<ComingSoonChannel, string> = {
  slack: 'Slack',
  whatsapp: 'WhatsApp',
};

const BLURB: Record<ComingSoonChannel, string> = {
  slack: 'Slack app — coming soon.',
  whatsapp: 'WhatsApp gateway — coming soon.',
};

/** Placeholder card for a channel with no adapter yet — disabled connect CTA. */
export default function ComingSoonChannelCard({ channel }: { channel: ComingSoonChannel }) {
  return (
    <div className="bg-paper border border-rule-2 rounded-xl px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hover text-base"
            aria-hidden="true"
          >
            {ICON[channel]}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{LABEL[channel]}</p>
            <p className="text-xs text-ink-3">{BLURB[channel]}</p>
          </div>
        </div>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="shrink-0 px-4 py-2 text-sm font-medium border border-rule-2 text-ink-4 rounded-lg cursor-not-allowed"
        >
          Connect
        </button>
      </div>
    </div>
  );
}
