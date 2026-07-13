'use client';

import type { ReactNode } from 'react';
import Modal, { ModalFooter } from '@/components/ui/Modal.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';

/**
 * ChannelGuideModal — shared shell for the four channel "Setup guide"
 * modals (Discord/Slack/Telegram/WhatsApp, UX-B8). A dismissable info modal
 * (backdrop click, Esc, and the corner close both work: no mutable state to
 * lose) with a single Close action in the footer, per Modal/ModalFooter's
 * documented convention.
 *
 * Content is composed with `GuideStep` for the numbered walkthrough; use the
 * existing `Banner` component (warn/tip variants) for pitfalls and callouts,
 * and drop in `SlackManifestBlock` (or any other copy block) directly where
 * a step needs one.
 */
export default function ChannelGuideModal({
  open,
  onClose,
  channel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  channel: string;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Connect ${channel}`}
      className="max-w-2xl"
      footer={
        <ModalFooter>
          <PrimaryButton variant="neutral" onClick={onClose}>
            Close
          </PrimaryButton>
        </ModalFooter>
      }
    >
      <div className="space-y-5">{children}</div>
    </Modal>
  );
}

/** One numbered step in a guide: a circular index badge, bold title, body. */
export function GuideStep({
  n,
  title,
  children,
}: {
  n: number;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-rule-2 bg-canvas text-xs font-mono text-ink-2">
        {n}
      </span>
      <div className="flex-1 space-y-2 pt-0.5">
        <p className="text-sm font-medium text-ink">{title}</p>
        <div className="space-y-2 text-sm text-ink-3">{children}</div>
      </div>
    </div>
  );
}
