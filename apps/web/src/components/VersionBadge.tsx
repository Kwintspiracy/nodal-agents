'use client';

import { useEffect, useState } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import PrimaryButton from '@/components/ui/PrimaryButton';
import IconTextButton from '@/components/ui/IconTextButton';
import CopyButton from '@/components/ui/CopyButton';
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

  return (
    <div className="mt-1">
      {updateAvailable ? (
        <IconTextButton
          onClick={() => setOpen(true)}
          className="gap-2 rounded-lg border border-agent-vivid/40 bg-agent-vivid/10 px-2.5 py-1.5 hover:bg-agent-vivid/20"
          icon={<ArrowClockwise size={14} weight="bold" className="text-ink-2" />}
          title="Update available"
          subtitle={`v${current} → v${latest}`}
        />
      ) : (
        // Au repos, la ligne de version est une PHRASE et rien d'autre
        // (planches de Quentin du 19/09/2026) : mono 10, `ink-4`, 8 px de
        // retrait, alignée sur les titres de section au-dessus d'elle. La
        // coche verte qui l'ouvrait disait « à jour », ce que l'absence de
        // badge de mise à jour dit déjà.
        <div className="px-2 py-1 font-mono text-legacy-10 text-ink-4">Nodal v{current}</div>
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
          <p className="text-body-13 leading-relaxed! text-ink-2">
            A new version is available - <span className="font-mono text-ink-3">v{current}</span> →{' '}
            <span className="font-mono font-medium text-ink">v{latest}</span>. Run this in your
            terminal, then restart Nodal-Agents:
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-rule-2 bg-hover px-3 py-2.5">
            <code className="flex-1 text-mono-13 text-ink">{UPDATE_CMD}</code>
            <CopyButton value={UPDATE_CMD} successMessage="Command copied" />
          </div>
          <p className="text-body-12 leading-relaxed! text-ink-4">
            On macOS/Linux, prefix with <span className="font-mono">sudo</span> if the global
            install needs elevated permissions.
          </p>
        </div>
      </Modal>
    </div>
  );
}
