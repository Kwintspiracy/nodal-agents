'use client';

/**
 * LanCommandYoloSection — settings block for the workspace-owner opt-in that
 * allows Yolo (auto-approve run_command) in non-local-trust (LAN/local-auth)
 * mode.
 *
 * In local-trust mode this section is hidden: Yolo is always available on the
 * agent edit page, so there is nothing to configure here.
 *
 * In local-auth / bearer-token mode:
 *   - The OWNER sees a toggle (default off).
 *   - Non-owners see the current state read-only with a note.
 *   - Enabling shows a ConfirmDialog warning (security relaxation).
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setLanCommandYoloAction, type LanCommandYoloView } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Banner from '@/components/ui/Banner';

interface Props {
  initial: LanCommandYoloView;
}

export default function LanCommandYoloSection({ initial }: Props) {
  const [enabled, setEnabled] = useState(initial.lanCommandYolo);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    if (!enabled) {
      // Enabling — show confirm first (security relaxation)
      setConfirmOpen(true);
    } else {
      // Disabling — no confirm needed
      doSet(false);
    }
  }

  function doSet(next: boolean) {
    // Optimistic update
    setEnabled(next);
    startTransition(async () => {
      const r = await setLanCommandYoloAction({ enabled: next });
      if (!r.ok) {
        toast.error(r.message);
        // Revert
        setEnabled(!next);
      } else {
        toast.success(
          next
            ? 'Yolo mode enabled for this workspace — agents with the command-execution skill can auto-run commands.'
            : 'Yolo mode disabled — commands require approval again.',
        );
      }
    });
  }

  const isDisabled = !initial.isOwner || isPending;

  return (
    <div className="flex items-start gap-4 rounded-xl border border-rule-2 bg-paper px-[18px] py-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-ink">
            Allow command auto-run (Yolo) in LAN / multi-user mode
          </span>
          <span className="inline-flex h-[18px] items-center rounded-full bg-err/10 px-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-err">
            owner only
          </span>
        </div>
        <p className="mt-1 text-[12px] leading-[1.4] text-ink-3">
          When on, workspace agents with the{' '}
          <span className="font-medium text-ink-2">command-execution</span> skill can be set to
          auto-run shell commands with no per-command approval. The toggle on each agent&apos;s
          Autonomy tab becomes available. Commands are still logged.
        </p>

        {!initial.isOwner && (
          <p className="mt-2 text-[11.5px] text-ink-4">
            Only the workspace owner can change this setting.
          </p>
        )}

        {enabled && initial.isOwner && (
          <Banner variant="warn">
            <span>
              <b className="block font-medium text-ink">
                Yolo is enabled — commands run with no approval gate
              </b>
              Any agent in this workspace that has the command-execution skill and Yolo toggled on
              will execute shell commands immediately. Only agents you fully trust should have this
              combination.
            </span>
          </Banner>
        )}
      </div>

      {/* Toggle */}
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={isDisabled}
        onClick={handleToggle}
        className={[
          'relative mt-0.5 inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          enabled ? 'border-err/40 bg-err/20' : 'border-rule-2 bg-canvas',
        ].join(' ')}
      >
        <span
          className={[
            'inline-block h-[16px] w-[16px] rounded-full shadow-sm transition-transform',
            enabled ? 'translate-x-[18px] bg-err' : 'translate-x-[2px] bg-ink-3',
          ].join(' ')}
        />
      </button>

      <ConfirmDialog
        open={confirmOpen}
        title="Enable Yolo mode for this workspace?"
        message="This lets any agent in this workspace auto-run shell commands with no approval gate, as long as it has the command-execution skill and Yolo toggled on in its Autonomy tab. Only enable for agents you fully trust. Commands are still logged."
        confirmLabel="Enable Yolo"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          doSet(true);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
