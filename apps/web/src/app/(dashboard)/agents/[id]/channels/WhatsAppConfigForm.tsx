'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import {
  startWhatsAppPairingAction,
  getWhatsAppPairingStatusAction,
  disconnectAgentChannelAction,
  type WhatsAppPairingStatus,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';

const POLL_INTERVAL_MS = 2000;
// Statuses that don't need another poll: 'open' and 'logged_out' are stable
// until the user acts again, 'disconnected' means there's no binding to poll.
const SETTLED = new Set<WhatsAppPairingStatus>(['open', 'logged_out', 'disconnected']);

function statusDotClass(status: WhatsAppPairingStatus): string {
  if (status === 'open') return 'inline-block w-2 h-2 rounded-full bg-agent-vivid';
  if (status === 'disconnected' || status === 'logged_out') {
    return 'inline-block w-2 h-2 rounded-full bg-ink-4';
  }
  return 'inline-block w-2 h-2 rounded-full bg-warn animate-pulse';
}

function statusLabel(status: WhatsAppPairingStatus): string {
  switch (status) {
    case 'open':
      return 'Connected';
    case 'qr_pending':
      return 'Waiting for scan';
    case 'connecting':
      return 'Connecting…';
    case 'closed':
      return 'Reconnecting…';
    case 'logged_out':
      return 'Session ended';
    case 'disconnected':
      return 'Not connected';
    default: {
      // Exhaustiveness guard — a new WhatsAppPairingStatus member must be handled above.
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * WhatsApp's connect/disconnect form — unlike Discord/Slack/Telegram's
 * paste-a-token forms, this pairs by QR (Baileys/WhatsApp Web): Connect kicks
 * off pairing (startWhatsAppPairingAction), then this component polls
 * getWhatsAppPairingStatusAction every ~2s and renders whatever the runner's
 * live socket reports (qr_pending → QR code, open → connected, logged_out →
 * offer to reconnect). Poll failures (e.g. the runner isn't up yet) are
 * skipped silently rather than toasted — a transient blip every 2s would be
 * noise, not signal.
 */
export default function WhatsAppConfigForm({
  agentId,
  initialStatus,
}: {
  agentId: string;
  initialStatus: 'connected' | 'disconnected';
}) {
  const router = useRouter();
  const [status, setStatus] = useState<WhatsAppPairingStatus>(
    initialStatus === 'connected' ? 'connecting' : 'disconnected',
  );
  const [qr, setQr] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [identityLabel, setIdentityLabel] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Poll the runner-backed status while not settled — mirrors
  // JobStatusPoller's TERMINAL-set pattern.
  useEffect(() => {
    if (SETTLED.has(status)) return;

    const tick = async () => {
      const r = await getWhatsAppPairingStatusAction(agentId);
      if (r.ok) {
        setStatus(r.data.status);
        setQr(r.data.qr);
        setIdentityLabel(r.data.identityLabel);
      }
    };

    void tick();
    const id = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [agentId, status]);

  // Render the raw QR payload client-side — never generated server-side.
  // Deliberately does NOT reset qrDataUrl to null when `qr` clears: the
  // surrounding render already gates the QR image on `status` (only shown
  // while connecting/qr_pending/closed), so a stale data URL is harmless and
  // avoids a synchronous setState in the effect body (react-hooks lint).
  useEffect(() => {
    if (!qr) return;
    let cancelled = false;
    QRCode.toDataURL(qr)
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [qr]);

  function handleConnect(): void {
    startTransition(async () => {
      const r = await startWhatsAppPairingAction(agentId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setQr(null);
      setQrDataUrl(null);
      setStatus('connecting');
    });
  }

  function performDisconnect(): void {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await disconnectAgentChannelAction({ agentId, channel: 'whatsapp' });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setStatus('disconnected');
      setQr(null);
      setQrDataUrl(null);
      setIdentityLabel(null);
      toast.success('WhatsApp disconnected');
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {/* Status block */}
      <div className="bg-paper border border-rule-2/60 rounded-xl px-5 py-4">
        <div className="flex items-center gap-2">
          <span className={statusDotClass(status)} aria-hidden="true" />
          <span className="text-sm font-medium text-ink">{statusLabel(status)}</span>
        </div>
        {identityLabel && (
          <p className="text-xs text-ink-3 mt-1.5">
            Linked as <span className="font-mono text-ink-2">{identityLabel}</span>
          </p>
        )}
      </div>

      {status === 'disconnected' && (
        <PrimaryButton
          type="button"
          variant="ink"
          size="sm"
          onClick={handleConnect}
          disabled={isPending}
        >
          {isPending ? 'Starting…' : 'Connect WhatsApp'}
        </PrimaryButton>
      )}

      {(status === 'connecting' || status === 'qr_pending' || status === 'closed') && (
        <div className="flex flex-col items-center gap-3 bg-canvas border border-rule-2 rounded-xl px-5 py-5">
          {qrDataUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- data: URI from qrcode, not a static asset */}
              <img src={qrDataUrl} alt="WhatsApp pairing QR code" className="w-48 h-48" />
              <p className="text-xs text-ink-3 text-center">
                WhatsApp → Settings → Linked devices → Link a device
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-3">Waiting for a pairing code…</p>
          )}
        </div>
      )}

      {status === 'open' && (
        <PrimaryButton
          type="button"
          variant="neutral"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={isPending}
        >
          Disconnect
        </PrimaryButton>
      )}

      {status === 'logged_out' && (
        <div className="space-y-3">
          <p className="text-sm text-warn">
            This session was unlinked from your phone. Reconnect to pair again.
          </p>
          <PrimaryButton
            type="button"
            variant="ink"
            size="sm"
            onClick={handleConnect}
            disabled={isPending}
          >
            {isPending ? 'Starting…' : 'Reconnect'}
          </PrimaryButton>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Disconnect WhatsApp?"
        message="Incoming messages will stop being processed. You can reconnect later by scanning a new QR code."
        confirmLabel="Disconnect"
        onConfirm={performDisconnect}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
