'use client';

import { useState } from 'react';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Banner from '@/components/ui/Banner.tsx';
import ChannelGuideModal, { GuideStep } from './ChannelGuideModal.tsx';

/**
 * Discord's "Setup guide" trigger + modal (UX-B8). Covers the full path from
 * the developer portal to a working reply, not just the token: the ownership
 * claim (first DM) and the per-channel approval flow were the two steps
 * missing from the old inline `<details>` guide.
 */
export default function DiscordConnectGuide() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <PrimaryButton variant="neutral" size="sm" onClick={() => setOpen(true)}>
        Setup guide
      </PrimaryButton>
      <ChannelGuideModal open={open} onClose={() => setOpen(false)} channel="Discord">
        <GuideStep n={1} title="Get a Discord server you own">
          <p>
            Bots can only be messaged, even in DM, by people who share a server with them. No server
            yet? In the Discord app, click the <span className="font-mono text-ink-2">+</span>{' '}
            button in the left column, then{' '}
            <span className="font-mono text-ink-2">Create My Own</span>.
          </p>
        </GuideStep>
        <GuideStep n={2} title="Create the application">
          <p>
            Open{' '}
            <a
              href="https://discord.com/developers/applications"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ok hover:underline"
            >
              discord.com/developers/applications
            </a>{' '}
            → <span className="font-mono text-ink-2">New Application</span> (top right) → give it a
            name (this becomes the bot&apos;s name) → accept the terms →{' '}
            <span className="font-mono text-ink-2">Create</span>.
          </p>
        </GuideStep>
        <GuideStep n={3} title="Turn on the two privileged intents">
          <p>
            Left sidebar → <span className="font-mono text-ink-2">Bot</span>. Scroll to{' '}
            <span className="font-mono text-ink-2">Privileged Gateway Intents</span> and switch ON{' '}
            <span className="font-mono text-ink-2">Server Members Intent</span> AND{' '}
            <span className="font-mono text-ink-2">Message Content Intent</span> (without the second
            one the bot receives empty messages).
          </p>
          <Banner variant="warn" title="Click Save Changes">
            A save bar pops up at the bottom of the page. The toggles do not save themselves.
          </Banner>
        </GuideStep>
        <GuideStep n={4} title="Copy the bot token">
          <p>
            Still on the <span className="font-mono text-ink-2">Bot</span> page, near the top: click{' '}
            <span className="font-mono text-ink-2">Reset Token</span> (Discord may ask for your
            password or 2FA code) → copy the token. It is shown only once: if you lose it, reset
            again.
          </p>
        </GuideStep>
        <GuideStep n={5} title="Build the invite URL">
          <p>
            Left sidebar → <span className="font-mono text-ink-2">OAuth2</span> → scroll to{' '}
            <span className="font-mono text-ink-2">OAuth2 URL Generator</span>. In{' '}
            <span className="font-mono text-ink-2">Scopes</span>, tick{' '}
            <span className="font-mono">bot</span> and{' '}
            <span className="font-mono">applications.commands</span>. A{' '}
            <span className="font-mono text-ink-2">Bot Permissions</span> grid appears below: tick{' '}
            <span className="font-mono">View Channels</span>,{' '}
            <span className="font-mono">Send Messages</span>,{' '}
            <span className="font-mono">Read Message History</span>,{' '}
            <span className="font-mono">Attach Files</span>,{' '}
            <span className="font-mono">Embed Links</span>.
          </p>
        </GuideStep>
        <GuideStep n={6} title="Invite the bot to your server">
          <p>
            Copy the <span className="font-mono text-ink-2">Generated URL</span> at the very bottom,
            open it in a new tab, pick your server in the dropdown →{' '}
            <span className="font-mono text-ink-2">Authorize</span>. The bot appears in your
            server&apos;s member list (offline is normal, it wakes up once connected below).
          </p>
        </GuideStep>
        <GuideStep n={7} title="Connect it in Nodal">
          <p>
            Paste the token in the <span className="font-mono text-ink-2">Bot token</span> field
            above → <span className="font-mono text-ink-2">Connect</span>.
          </p>
        </GuideStep>
        <GuideStep n={8} title="DM the bot first">
          <p>
            Right-click it in the member list →{' '}
            <span className="font-mono text-ink-2">Message</span>, and send anything. The first
            private message you send claims you as this bot&apos;s owner; before that, no one can
            use it.
          </p>
        </GuideStep>
        <GuideStep n={9} title="Mention it in a server channel">
          <p>
            Anyone can @ mention the bot in a channel it&apos;s in. The autocomplete inserts a role
            mention instead of a user mention: that is expected, the bot handles it the same way.
          </p>
          <p>
            Since that conversation isn&apos;t the owner yet, the owner gets an approval request
            with Allow/Deny buttons in DM. The bot only replies in that channel once approved.
          </p>
        </GuideStep>
        <GuideStep n={10} title="Verify it works">
          <p>
            Send the DM from step 8: expect a reply within a few seconds, and the job listed on the
            Jobs page.
          </p>
          <p>
            Then mention the bot in a channel: expect an approval request in the owner&apos;s DM,
            and a reply in the channel once you click Allow.
          </p>
          <Banner variant="tip" title="Connected but silent in a channel">
            That almost always means step 8 was skipped (no owner yet), or the approval request is
            still waiting in the owner&apos;s DM.
          </Banner>
        </GuideStep>
      </ChannelGuideModal>
    </>
  );
}
