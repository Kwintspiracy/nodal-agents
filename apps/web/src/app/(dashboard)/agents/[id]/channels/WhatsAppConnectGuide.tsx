'use client';

import { useState } from 'react';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Banner from '@/components/ui/Banner.tsx';
import ChannelGuideModal, { GuideStep } from './ChannelGuideModal.tsx';

/**
 * WhatsApp's "Setup guide" trigger + modal (UX-B8). The card already shows
 * the unofficial-bridge warning as a standing banner; this guide restates it
 * as step 1 for the E2E walkthrough, then covers QR pairing through to the
 * ownership claim (a message from a DIFFERENT phone, since the linked number
 * itself becomes the bot).
 */
export default function WhatsAppConnectGuide() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <PrimaryButton variant="neutral" size="sm" onClick={() => setOpen(true)}>
        Setup guide
      </PrimaryButton>
      <ChannelGuideModal open={open} onClose={() => setOpen(false)} channel="WhatsApp">
        <GuideStep n={1} title="This is an unofficial bridge">
          <p>
            It links through WhatsApp Web (Baileys), not Meta&apos;s own bot API: prefer a dedicated
            number rather than your main one, there is a small risk of account restriction.
          </p>
        </GuideStep>
        <GuideStep n={2} title="Click Connect WhatsApp above">
          <p>A QR code appears.</p>
        </GuideStep>
        <GuideStep n={3} title="Scan it">
          <p>
            On the phone whose number you are linking: WhatsApp →{' '}
            <span className="font-mono text-ink-2">Settings → Linked devices → Link a device</span>{' '}
            → scan the code shown.
          </p>
        </GuideStep>
        <GuideStep n={4} title="Wait for Connected">
          <p>The status flips and shows the linked identity.</p>
        </GuideStep>
        <GuideStep n={5} title="Message it first, from a different phone">
          <p>
            From another number (not the one you just linked), send a WhatsApp message to the linked
            number. That first private conversation claims its sender as the owner.
          </p>
        </GuideStep>
        <GuideStep n={6} title="Verify it works">
          <p>Send the message from step 5: expect a reply, and the job listed on the Jobs page.</p>
          <Banner variant="tip" title="Connected but no reply">
            Usually means step 5 has not happened yet, so there is no owner.
          </Banner>
        </GuideStep>
      </ChannelGuideModal>
    </>
  );
}
