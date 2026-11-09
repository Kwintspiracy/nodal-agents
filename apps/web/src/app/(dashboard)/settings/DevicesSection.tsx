'use client';

/**
 * DevicesSection — Settings → Devices (#946), the owner-validated mock-up of
 * 2026-11-09: its structure, states and copy are the spec.
 *
 * A device pairs FROM ITS OWN SIDE: it asks Nodal for a code, shows it or says
 * it, and its request appears here with that code. The owner checks that the
 * two match and confirms; the device then gets its own key. Five states:
 *   1. no device yet: the three steps, and the address a device connects to
 *      (or, when Nodal only listens on this computer, the way to Access);
 *   2. a device asks to pair: its card, with its code and its expiry;
 *   3. paired devices: one row each, Rename and Remove;
 *   4. Remove asks first (`<ConfirmDialog />`, invariant #10);
 *   5. after a removal, the toast; an expired request, its card.
 *
 * What a request sends, its name above all, is rendered as TEXT by React and
 * never as markup.
 *
 * The section reads the runner itself (device-actions.ts) and reads again
 * every few seconds: a request arrives from the device, not from this page.
 */

import { useCallback, useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { DeviceCapability, DevicePairingView, PairedDeviceView } from '@nodal-agents/shared';
import {
  confirmDevicePairingAction,
  dismissDevicePairingAction,
  getDevicesAction,
  refuseDevicePairingAction,
  removeDeviceAction,
  renameDeviceAction,
  type DevicesView,
} from '@/lib/device-actions.ts';
import type { DeviceAddress } from '@/lib/device-address.ts';
import { formatDate, relativeTime } from '@/lib/format-time.ts';
import { usePolling } from '@/lib/use-polling.ts';
import { announceDevicePairingsCount } from '@/components/sidebar/use-device-pairings-count.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Banner from '@/components/ui/Banner.tsx';
import DisclosureButton from '@/components/ui/DisclosureButton.tsx';
import MonoCode from '@/components/ui/MonoCode';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import RenameDialog from '@/components/ui/RenameDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import { TagMini } from '@/components/ui/TagMini.tsx';

/** How often the section reads again: a request arrives from the device side. */
const DEVICES_POLL_MS = 3_000;

const CAPABILITY_LABEL: Record<DeviceCapability, string> = {
  microphone: 'Microphone',
  speaker: 'Speaker',
  screen: 'Screen',
  buttons: 'Buttons',
};

function Chips({ capabilities }: { capabilities: readonly DeviceCapability[] }) {
  if (capabilities.length === 0)
    return <span className="text-body-13 text-ink-4">Nothing declared</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {capabilities.map((c) => (
        <TagMini key={c} variant="neutral">
          {CAPABILITY_LABEL[c]}
        </TagMini>
      ))}
    </span>
  );
}

/** `482913` → `482 913`: easier to compare with what the device shows or says. */
function spacedCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** `m:ss` until `expiresAt`. */
function countdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** A line of a request card: what it is, then the fact. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
      <span className="w-28 shrink-0 text-body-13 text-ink-3">{label}</span>
      <span className="min-w-0 text-body-14 text-ink">{children}</span>
    </div>
  );
}

/** "The address a device connects to", read from the real network setting. */
function DeviceAddressRow({ address }: { address: DeviceAddress }) {
  return (
    <div className="flex flex-col gap-2" data-testid="device-address">
      <span className="text-medium-13 text-ink-2">The address a device connects to</span>
      {address.mode === 'loopback' ? (
        <>
          <Banner variant="warn" role="status">
            Nodal only listens on this computer. A device on your network cannot reach it. Turn on
            network access to pair one.{' '}
            <Link href="/settings?page=access" className="underline">
              Open Access
            </Link>
          </Banner>
          {address.urls.map((u) => (
            <span key={u} className="flex flex-wrap items-center gap-2 text-body-13 text-ink-3">
              On this computer: <MonoCode>{u}</MonoCode>
            </span>
          ))}
        </>
      ) : address.urls.length === 0 ? (
        <span className="text-body-13 text-warn">
          No network address was found on this computer.
        </span>
      ) : (
        <span className="flex flex-wrap gap-2">
          {address.urls.map((u) => (
            <MonoCode key={u}>{u}</MonoCode>
          ))}
        </span>
      )}
      {/* SLOT for #950 / #947: the TypeScript / Python example tab (the
          snippet comes from the device kit) and the "Protocol and full
          examples" link. Left empty on purpose: no snippet is written here
          before the kit exists, so nothing on this page can drift from it. */}
      <DeviceKitExamplesSlot />
    </div>
  );
}

/** Filled by the device-kit PR. Renders nothing until then. */
function DeviceKitExamplesSlot(): null {
  return null;
}

/** The three steps, and the address: how a device pairs. */
function HowToPair({ address }: { address: DeviceAddress }) {
  return (
    <div className="flex flex-col gap-4" data-testid="devices-how-to-pair">
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-body-14 text-ink-2">
        <li>The device asks Nodal for a pairing code, then shows it or says it aloud.</li>
        <li>Its request appears on this page with that code. Check that the two match.</li>
        <li>You confirm. The device gets its own key, which only lets it talk with your agents.</li>
      </ol>
      <DeviceAddressRow address={address} />
    </div>
  );
}

/** "How a device pairs", folded once there is something else to look at. */
function HowToPairFolded({ address }: { address: DeviceAddress }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <DisclosureButton
        open={open}
        onClick={() => setOpen((o) => !o)}
        inset="none"
        testId="devices-how-to-pair-toggle"
      >
        <span className="text-medium-13 text-ink-2">How a device pairs</span>
      </DisclosureButton>
      {open && <HowToPair address={address} />}
    </div>
  );
}

function RequestCard({
  pairing,
  now,
  rootAgentName,
  canAct,
  pending,
  onConfirm,
  onRefuse,
}: {
  pairing: DevicePairingView;
  now: number;
  rootAgentName: string | null;
  canAct: boolean;
  pending: boolean;
  onConfirm: () => void;
  onRefuse: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-4 rounded-lg border border-rule-2 bg-paper p-4"
      data-testid={`pairing-request-${pairing.pairingId}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-title-15 text-ink">A device asks to pair</h3>
        <span className="text-mono-12 text-ink-3" data-testid="pairing-expiry">
          expires in {countdown(pairing.expiresAt, now)}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        <Fact label="Name it gives">{pairing.name}</Fact>
        <Fact label="It can">
          <Chips capabilities={pairing.capabilities} />
        </Fact>
        <Fact label="From">
          <span className="font-mono">{pairing.from}</span>
        </Fact>
        <Fact label="Asked">{relativeTime(pairing.requestedAt)}</Fact>
      </div>
      <div className="flex flex-col gap-1.5 rounded-md border border-rule-2 bg-canvas p-3">
        <span className="text-body-13 text-ink-3">Its code</span>
        <span
          className="font-mono text-display-28 tabular-nums text-ink"
          data-testid="pairing-code"
        >
          {spacedCode(pairing.userCode)}
        </span>
        <span className="text-body-13 text-ink-3">
          Check that the device shows or says this same code. If it does not, refuse.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton
          variant="ink"
          size="sm"
          onClick={onConfirm}
          disabled={!canAct || pending || rootAgentName === null}
        >
          Confirm and pair
        </PrimaryButton>
        <RowActionButton tone="danger" onClick={onRefuse} disabled={!canAct || pending}>
          Refuse
        </RowActionButton>
      </div>
      <p className="text-body-13 text-ink-3">
        {rootAgentName === null
          ? 'Set a root agent in Safety first. A device talks with it.'
          : `It will talk with ${rootAgentName}, your root agent.`}
      </p>
    </div>
  );
}

function ExpiredCard({
  pairing,
  canAct,
  onDismiss,
}: {
  pairing: DevicePairingView;
  canAct: boolean;
  onDismiss: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rule-2 bg-paper p-4"
      data-testid={`pairing-expired-${pairing.pairingId}`}
    >
      <p className="min-w-0 flex-1 text-body-14 text-ink-2">
        A pairing request expired. {pairing.name}, from {pairing.from}, was not confirmed within 10
        minutes. It can ask for a new code.
      </p>
      <RowActionButton onClick={onDismiss} disabled={!canAct}>
        Dismiss
      </RowActionButton>
    </div>
  );
}

function DeviceRow({
  device,
  rootAgentName,
  canAct,
  onRename,
  onRemove,
}: {
  device: PairedDeviceView;
  rootAgentName: string | null;
  canAct: boolean;
  onRename: () => void;
  onRemove: () => void;
}) {
  const facts = [
    rootAgentName === null ? null : `Talks with ${rootAgentName}`,
    `paired ${formatDate(device.pairedAt)}`,
    device.pairedFrom,
  ].filter((f): f is string => f !== null);
  return (
    <div
      className="flex flex-col gap-3 border-b border-rule-2 px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-center"
      data-testid={`device-row-${device.deviceId}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-medium-14 text-ink">{device.name}</span>
          {device.connected ? (
            <TagMini variant="ok">Connected</TagMini>
          ) : (
            <span className="text-mono-11 text-ink-4">
              {device.lastSeenAt === null
                ? 'never seen'
                : `last seen ${relativeTime(device.lastSeenAt)}`}
            </span>
          )}
        </div>
        <Chips capabilities={device.capabilities} />
        <span className="text-mono-11 text-ink-4">{facts.join(' · ')}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <RowActionButton onClick={onRename} disabled={!canAct}>
          Rename
        </RowActionButton>
        <RowActionButton tone="danger" onClick={onRemove} disabled={!canAct}>
          Remove
        </RowActionButton>
      </div>
    </div>
  );
}

export default function DevicesSection({
  address,
  rootAgentName,
}: {
  address: DeviceAddress;
  /** The workspace's root agent, the one a device talks with; null when none is set. */
  rootAgentName: string | null;
}) {
  const [view, setView] = useState<DevicesView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isPending, startTransition] = useTransition();
  const [renaming, setRenaming] = useState<PairedDeviceView | null>(null);
  const [removing, setRemoving] = useState<PairedDeviceView | null>(null);

  const read = useCallback(async () => {
    try {
      const res = await getDevicesAction();
      if (res.ok) {
        setView(res.data);
        setReadError(null);
        // The pill on "Devices" says what this page just read.
        announceDevicePairingsCount(res.data.pairings.filter((p) => p.state === 'pending').length);
      } else {
        setReadError(res.message);
      }
    } catch {
      setReadError('Could not reach the server.');
    }
  }, []);

  usePolling(read, DEVICES_POLL_MS, true);

  // The expiry counts down while a request waits.
  const waiting = view?.pairings.some((p) => p.state === 'pending') ?? false;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [waiting]);

  function gesture(run: () => Promise<{ ok: boolean; message?: string }>, done?: () => void) {
    startTransition(async () => {
      const res = await run();
      if (!res.ok) {
        toast.error(res.message ?? 'Something went wrong.');
      } else {
        done?.();
      }
      await read();
    });
  }

  if (view === null) {
    return readError === null ? (
      <p className="text-body-13 text-ink-3">Reading devices…</p>
    ) : (
      <p className="text-body-13 text-warn" data-testid="devices-unread">
        Could not read the devices. {readError}
      </p>
    );
  }

  const canAct = view.isOwner;
  const pending = view.pairings.filter(
    (p) => p.state === 'pending' && new Date(p.expiresAt).getTime() > now,
  );
  // A request whose countdown ran out here is shown as expired at once, not
  // at the next read.
  const expired = view.pairings.filter(
    (p) => p.state === 'expired' || new Date(p.expiresAt).getTime() <= now,
  );

  return (
    <div className="flex flex-col gap-4" data-testid="devices-section">
      {readError !== null && (
        <p className="text-body-13 text-warn">Could not read the devices again. {readError}</p>
      )}
      {view.pairingsRefused !== null && (
        <Banner variant="info" role="status">
          {view.pairingsRefused}
        </Banner>
      )}
      {!canAct && (
        <p className="text-body-13 text-ink-3">
          Only the workspace owner can pair or remove a device.
        </p>
      )}

      {pending.map((p) => (
        <RequestCard
          key={p.pairingId}
          pairing={p}
          now={now}
          rootAgentName={rootAgentName}
          canAct={canAct}
          pending={isPending}
          onConfirm={() => gesture(() => confirmDevicePairingAction(p.pairingId))}
          onRefuse={() => gesture(() => refuseDevicePairingAction(p.pairingId))}
        />
      ))}
      {expired.map((p) => (
        <ExpiredCard
          key={p.pairingId}
          pairing={p}
          canAct={canAct}
          onDismiss={() => gesture(() => dismissDevicePairingAction(p.pairingId))}
        />
      ))}

      <section className="flex flex-col gap-3" data-testid="devices-paired">
        <div className="flex items-baseline gap-2">
          <h3 className="text-title-15 text-ink">Paired devices</h3>
          <span className="text-mono-12 text-ink-3" data-testid="devices-count">
            {view.devices.length === 0 ? 'none' : view.devices.length}
          </span>
        </div>
        {view.devices.length === 0 ? (
          <div
            className="flex flex-col gap-4 rounded-lg border border-rule-2 bg-paper p-4"
            data-testid="devices-empty"
          >
            {pending.length === 0 && expired.length === 0 ? (
              <>
                <p className="text-body-14 text-ink">
                  No device yet. A device pairs from its own side, in three steps:
                </p>
                <HowToPair address={address} />
              </>
            ) : (
              <>
                <p className="text-body-14 text-ink">No device yet.</p>
                <HowToPairFolded address={address} />
              </>
            )}
          </div>
        ) : (
          <>
            <div
              className="overflow-hidden rounded-lg border border-rule-2 bg-paper"
              data-testid="devices-list"
            >
              {view.devices.map((d) => (
                <DeviceRow
                  key={d.deviceId}
                  device={d}
                  rootAgentName={rootAgentName}
                  canAct={canAct}
                  onRename={() => setRenaming(d)}
                  onRemove={() => setRemoving(d)}
                />
              ))}
            </div>
            <p className="text-body-13 text-ink-3">
              A device sees only its own conversation. It cannot change settings, agents or keys.
            </p>
            <HowToPairFolded address={address} />
          </>
        )}
      </section>

      {renaming !== null && (
        <RenameDialog
          key={renaming.deviceId}
          open
          title={`Rename ${renaming.name}`}
          currentName={renaming.name}
          pending={isPending}
          testId="rename-device"
          onCancel={() => setRenaming(null)}
          onSave={(name) => {
            const target = renaming;
            gesture(
              () => renameDeviceAction(target.deviceId, name),
              () => setRenaming(null),
            );
          }}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove ${removing.name}?` : ''}
        message="Its key stops working at once, and a reply it is playing is cut. To come back, it must pair again. Its past conversation stays in Chat."
        confirmLabel="Remove"
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target === null) return;
          gesture(
            () => removeDeviceAction(target.deviceId),
            () => toast.success(`${target.name} removed. Its key no longer works.`),
          );
        }}
      />
    </div>
  );
}
