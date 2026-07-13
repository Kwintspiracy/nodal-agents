'use client';

import { useState } from 'react';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Banner from '@/components/ui/Banner.tsx';
import ChannelGuideModal, { GuideStep } from './ChannelGuideModal.tsx';
import SlackManifestBlock from './SlackManifestBlock.tsx';

/**
 * Slack's "Setup guide" trigger + modal (UX-B8). Covers the two pitfalls the
 * user actually hit live: an app built by hand missing Socket Mode/event
 * scopes (connects but never receives anything, no visible symptom), and the
 * ownership + per-channel invite steps the old inline guide stopped short of.
 */
export default function SlackConnectGuide() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <PrimaryButton variant="neutral" size="sm" onClick={() => setOpen(true)}>
        Setup guide
      </PrimaryButton>
      <ChannelGuideModal open={open} onClose={() => setOpen(false)} channel="Slack">
        <GuideStep n={1} title="Create the app from the manifest">
          <p>
            Open{' '}
            <a
              href="https://api.slack.com/apps"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ok hover:underline"
            >
              api.slack.com/apps
            </a>{' '}
            → <span className="font-mono text-ink-2">Create New App</span> →{' '}
            <span className="font-mono text-ink-2">From a manifest</span> → paste the JSON below →{' '}
            <span className="font-mono text-ink-2">Create</span>.
          </p>
          <SlackManifestBlock />
          <Banner variant="warn" title="Do not build the app by hand instead">
            This manifest already turns on Socket Mode and the message events. An app created
            field-by-field that misses one of those ends up with a socket that connects but receives
            zero messages, with nothing on screen to say why.
          </Banner>
        </GuideStep>
        <GuideStep n={2} title="Install to workspace">
          <p>
            Any later change to scopes or events requires reinstalling the app to the workspace for
            it to take effect.
          </p>
        </GuideStep>
        <GuideStep n={3} title="Copy the bot token">
          <p>
            <span className="font-mono text-ink-2">
              Settings → Install App → Bot User OAuth Token
            </span>
            , starts with <span className="font-mono">xoxb-</span>.
          </p>
        </GuideStep>
        <GuideStep n={4} title="Copy the app-level token">
          <p>
            <span className="font-mono text-ink-2">
              Settings → Basic Information → App-Level Tokens
            </span>{' '}
            → <span className="font-mono text-ink-2">Generate</span> a token with the{' '}
            <span className="font-mono">connections:write</span> scope, starts with{' '}
            <span className="font-mono">xapp-</span>.
          </p>
        </GuideStep>
        <GuideStep n={5} title="Connect it in Nodal">
          <p>
            Paste both tokens above → <span className="font-mono text-ink-2">Connect</span>. The
            status flips to Connected with the bot&apos;s identity shown.
          </p>
        </GuideStep>
        <GuideStep n={6} title="DM the bot first">
          <p>
            Open a direct message with it and send anything. The first private conversation claims
            you as its owner; until someone is owner, mentions in channels are silently ignored.
            That is a deliberate security gate, not a bug.
          </p>
        </GuideStep>
        <GuideStep n={7} title="Invite it to a channel, then mention it">
          <p>
            Slack only sends the bot a channel&apos;s messages if it is a member of that channel:
            run <span className="font-mono text-ink-2">/invite @your-bot</span> first, then @
            mention it. Since that channel conversation isn&apos;t the owner, the owner gets an
            approval request in DM for it.
          </p>
        </GuideStep>
        <GuideStep n={8} title="Verify it works">
          <p>Send the DM from step 6: expect a reply, and the job listed on the Jobs page.</p>
          <p>
            Then invite and mention it in a channel: expect an approval request in the owner&apos;s
            DM, and a reply in the channel once approved.
          </p>
          <Banner variant="tip" title="Connected but no reply in a channel">
            Usually means the bot wasn&apos;t invited to that channel, step 6 was skipped, or the
            approval request is still waiting.
          </Banner>
        </GuideStep>
      </ChannelGuideModal>
    </>
  );
}
