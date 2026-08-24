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
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import Switch from '@/components/ui/Switch';

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
        {/* Copy v2 (24/08) : l'ancien titre « Allow command auto-run (Yolo) »
            se lisait comme « activer le Yolo du workspace » — une soirée de
            malentendu pour un interrupteur qui n'active RIEN par lui-même :
            il ne fait que déverrouiller les toggles PAR AGENT. */}
        <div className="flex items-center gap-2">
          <span className="text-medium-14 text-ink">
            Unlock per-agent Yolo on this network install
          </span>
          <MonoMicroTag tone="err">owner only</MonoMicroTag>
        </div>
        <p className="mt-1 text-body-13 leading-[1.4]! text-ink-3">
          Turns nothing on by itself. It unlocks the per-agent Yolo toggles — shell commands (
          <span className="font-medium text-ink-2">command-execution</span>) and coding CLI tasks (
          <span className="font-medium text-ink-2">code_task</span>) — on each agent&apos;s Autonomy
          tab. Every agent keeps asking for approval until you enable its own toggle. Runs are still
          logged.
        </p>

        {!initial.isOwner && (
          <p className="mt-2 text-body-12 text-ink-4">
            Only the workspace owner can change this setting.
          </p>
        )}

        {enabled && initial.isOwner && (
          <Banner variant="warn">
            <span>
              <b className="block font-medium text-ink">
                Per-agent Yolo is unlocked for this workspace
              </b>
              Agents whose own Yolo toggle is on (Autonomy tab) run shell commands and coding CLI
              tasks immediately, with no approval gate. Agents without it keep asking. Only give the
              per-agent toggle to agents you fully trust.
            </span>
          </Banner>
        )}
      </div>

      {/* Toggle */}
      <div className="mt-0.5">
        <Switch
          checked={enabled}
          onChange={handleToggle}
          disabled={isDisabled}
          trackClassName={enabled ? 'border-err/40 bg-err/20' : 'border-rule-2 bg-canvas'}
          thumbClassName={enabled ? 'translate-x-[18px] bg-err' : 'translate-x-[2px] bg-ink-3'}
        />
      </div>

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
