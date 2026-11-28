// ChannelLinkStatus.test.tsx — every channel's card says the state of its link
// as the runner recorded it: refused, lost for now, or nothing when it works.
// Table-driven over the four channels' config forms, so a channel whose card
// stops reading the state turns a case red.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionState } from '@nodal-agents/shared';

vi.mock('@/lib/actions.ts', () => {
  const noop = vi.fn(async () => ({ ok: true as const, data: undefined }));
  return {
    configureAgentChannelAction: noop,
    disconnectAgentChannelAction: noop,
    startWhatsAppPairingAction: noop,
    getWhatsAppPairingStatusAction: noop,
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => '') } }));

const { default: TelegramConfigForm } = await import('../TelegramConfigForm.tsx');
const { default: DiscordConfigForm } = await import('../DiscordConfigForm.tsx');
const { default: SlackConfigForm } = await import('../SlackConfigForm.tsx');
const { default: WhatsAppConfigForm } = await import('../WhatsAppConfigForm.tsx');

const base = { agentId: 'a1', agentSlug: 'agent', agentName: 'Agent' };
const at = new Date('2026-11-28T10:00:00Z');

const FORMS: Array<[string, (link: ConnectionState) => React.ReactElement]> = [
  [
    'telegram',
    (link) => (
      <TelegramConfigForm
        agentId="a1"
        initialConfig={{
          ...base,
          status: 'connected',
          botUsername: 'bot',
          lastSeenChatIdTelegram: null,
          link,
        }}
      />
    ),
  ],
  [
    'discord',
    (link) => (
      <DiscordConfigForm
        agentId="a1"
        initialConfig={{ ...base, status: 'connected', identityLabel: 'bot#1', link }}
      />
    ),
  ],
  [
    'slack',
    (link) => (
      <SlackConfigForm
        agentId="a1"
        initialConfig={{ ...base, status: 'connected', identityLabel: 'bot#U1', link }}
      />
    ),
  ],
  ['whatsapp', (link) => <WhatsAppConfigForm agentId="a1" initialStatus="connected" link={link} />],
];

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('every channel card says the state of its link @cap:parler-par-canal-externe/ecran', () => {
  it('the table covers every channel', async () => {
    const { CHANNELS } = await import('@nodal-agents/shared');
    expect(FORMS.map(([c]) => c).sort()).toEqual([...CHANNELS].sort());
  });

  for (const [channel, render] of FORMS) {
    it(`${channel}: refused for good, the card says Reconnect and why`, () => {
      const html = renderToStaticMarkup(
        render({
          state: 'needs_reauth',
          cause: 'grant_refused',
          detail: `${channel}_invalid_token`,
          observedAt: at,
          retryAfter: null,
        }),
      );
      expect(html).toContain('data-channel-link="needs_reauth"');
      expect(text(html)).toContain('Reconnect');
      expect(text(html)).toContain('The provider no longer accepts this authorisation.');
    });

    it(`${channel}: lost for now, the card says unreachable and when it tries again`, () => {
      const html = renderToStaticMarkup(
        render({
          state: 'unreachable',
          cause: 'provider_unavailable',
          detail: 'disconnected',
          observedAt: at,
          retryAfter: new Date('2026-11-28T10:01:00Z'),
        }),
      );
      expect(html).toContain('data-channel-link="unreachable"');
      expect(text(html)).toContain('Unreachable');
      expect(text(html)).toContain('Nodal tries again after');
    });

    it(`${channel}: back to working, no warning`, () => {
      const html = renderToStaticMarkup(
        render({
          state: 'working',
          cause: 'succeeded',
          detail: null,
          observedAt: at,
          retryAfter: null,
        }),
      );
      expect(html).not.toContain('data-channel-link');
    });
  }
});
