'use client';

import { useState } from 'react';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Banner from '@/components/ui/Banner.tsx';
import ChannelGuideModal, { GuideStep } from './ChannelGuideModal.tsx';

/**
 * Telegram's "Setup guide" trigger + modal (UX-B8). Same shape as the other
 * three channels: token setup plus the ownership claim and group-mention
 * rules the old inline guide left out.
 */
export default function TelegramConnectGuide() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <PrimaryButton variant="neutral" size="sm" onClick={() => setOpen(true)}>
        Setup guide
      </PrimaryButton>
      <ChannelGuideModal open={open} onClose={() => setOpen(false)} channel="Telegram">
        <GuideStep n={1} title="Open @BotFather">
          <p>
            On Telegram, message{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ok hover:underline"
            >
              @BotFather
            </a>
            .
          </p>
        </GuideStep>
        <GuideStep n={2} title="Create the bot">
          <p>
            Send <span className="font-mono text-ink-2">/newbot</span> and follow the prompts to
            pick a name and a username.
          </p>
        </GuideStep>
        <GuideStep n={3} title="Copy the token">
          <p>
            BotFather replies with a token shaped like{' '}
            <span className="font-mono">123456789:ABC...</span> → paste it above →{' '}
            <span className="font-mono text-ink-2">Save</span>.
          </p>
        </GuideStep>
        <GuideStep n={4} title="Message it first">
          <p>
            Open a DM with your bot and send anything. The first private message claims you as its
            owner; until then, no one can use it.
          </p>
        </GuideStep>
        <GuideStep n={5} title="For group chats">
          <p>
            Add the bot to the group, then send{' '}
            <span className="font-mono text-ink-2">/setprivacy</span> to @BotFather → choose your
            bot → <span className="font-mono">Disable</span>, otherwise it only sees commands.
          </p>
          <p>
            In the group it only responds to an exact{' '}
            <span className="font-mono text-ink-2">@username</span> mention or a reply to one of its
            own messages. A new group conversation still needs the owner&apos;s approval, the same
            way a new DM does.
          </p>
        </GuideStep>
        <GuideStep n={6} title="Verify it works">
          <p>Send the DM from step 4: expect a reply, and the job listed on the Jobs page.</p>
          <p>
            In a group, mention it by its exact @username or reply to it: expect an approval request
            in the owner&apos;s DM, then a reply once approved.
          </p>
          <Banner variant="tip" title="Connected but silent in a group">
            Usually means <span className="font-mono">/setprivacy</span> is still Enable, the
            mention wasn&apos;t exact, or the owner hasn&apos;t approved yet.
          </Banner>
        </GuideStep>
      </ChannelGuideModal>
    </>
  );
}
