'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowClockwise, CheckCircle, Copy } from '@phosphor-icons/react';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { getVersionInfoAction, type VersionInfo } from '@/lib/actions.ts';

const UPDATE_CMD = 'nodal-agents update';

/**
 * VersionBadge — sidebar footer. Shows the running Nodal-Agents version and,
 * when a newer one is published on npm, a clickable "Update available" badge
 * that opens a modal reminding the user of the one-line update command.
 * Renders nothing until the version is known (and nothing at all if the
 * launcher didn't inject NODAL_VERSION — e.g. a bare `next dev`).
 */
export default function VersionBadge() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    getVersionInfoAction()
      .then((r) => {
        if (alive && r.ok) setInfo(r.data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!info?.current) return null;
  const { current, latest, updateAvailable } = info;

  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(UPDATE_CMD);
      toast.success('Command copied');
    } catch {
      toast.error('Could not copy');
    }
  }

  return (
    <div className="mx-2 mt-1">
      {updateAvailable ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg border border-agent-vivid/40 bg-agent-vivid/10 px-2.5 py-1.5 text-left transition-colors hover:bg-agent-vivid/20"
        >
          <ArrowClockwise size={14} weight="bold" className="shrink-0 text-ink-2" />
          <span className="min-w-0 flex-1">
            <span className="block text-[11.5px] font-medium leading-tight text-ink">
              Update available
            </span>
            <span className="block font-mono text-[10px] leading-tight text-ink-3">
              v{current} → v{latest}
            </span>
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-ink-4">
          <CheckCircle size={12} className="shrink-0" />
          <span className="font-mono text-[10.5px]">Nodal v{current}</span>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Update Nodal-Agents"
        footer={
          <ModalFooter>
            <PrimaryButton variant="neutral" onClick={() => setOpen(false)}>
              Close
            </PrimaryButton>
          </ModalFooter>
        }
      >
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-ink-2">
            A new version is available - <span className="font-mono text-ink-3">v{current}</span> →{' '}
            <span className="font-mono font-medium text-ink">v{latest}</span>. Run this in your
            terminal, then restart Nodal-Agents:
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-rule-2 bg-hover px-3 py-2.5">
            <code className="flex-1 font-mono text-[13px] text-ink">{UPDATE_CMD}</code>
            <button
              type="button"
              onClick={copyCmd}
              className="inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-md border border-rule-2 bg-paper px-2.5 text-[12px] font-medium text-ink-3 transition-colors hover:text-ink"
            >
              <Copy size={13} /> Copy
            </button>
          </div>
          <p className="text-[12px] leading-relaxed text-ink-4">
            On macOS/Linux, prefix with <span className="font-mono">sudo</span> if the global
            install needs elevated permissions.
          </p>
        </div>
      </Modal>
    </div>
  );
}
