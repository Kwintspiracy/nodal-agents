'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateNetworkSettingsAction, type NetworkView } from '@/lib/actions.ts';
import { OptionRadio } from '@/components/ui/OptionRadio.tsx';
import Banner from '@/components/ui/Banner';
import { SetUrl } from '@/components/ui/SetUrl.tsx';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import { SetForm } from '@/components/ui/SetForm.tsx';

interface Props {
  initial: NetworkView;
}

export default function NetworkForm({ initial }: Props) {
  const [bind, setBind] = useState<'loopback' | 'lan'>(initial.configuredBind);
  const [isPending, startTransition] = useTransition();
  const [restartHint, setRestartHint] = useState(false);
  const [authAlignedHint, setAuthAlignedHint] = useState(false);

  function handleReset() {
    setBind(initial.configuredBind);
    setRestartHint(false);
    setAuthAlignedHint(false);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const r = await updateNetworkSettingsAction({ bind });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Network settings saved');
        setRestartHint(r.data.requiresRestart);
        setAuthAlignedHint(r.data.authModeAligned);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <SetForm label="Network access">
        <OptionRadio
          active={bind === 'loopback'}
          onClick={() => setBind('loopback')}
          name="Local only (127.0.0.1)"
          description="Only this machine can reach the dashboard. No auth required by default."
        />
        <OptionRadio
          active={bind === 'lan'}
          onClick={() => setBind('lan')}
          name="LAN (0.0.0.0) — accessible from your network"
          description="Other devices on the same Wi-Fi can reach the dashboard. Sign-in required (local-auth)."
        />

        {bind === 'lan' && initial.lanAddresses.length > 0 && (
          <>
            <Banner variant="info">
              Any device on the same Wi-Fi can open the dashboard. Combine with email + password
              auth to avoid unintended access.
            </Banner>

            {initial.lanAddresses.map((ip) => {
              const url = `http://${ip}:${initial.webPort}`;
              return (
                <SetUrl
                  key={ip}
                  subtitle="From your phone or another device on the same network, open:"
                  url={url}
                />
              );
            })}

            <p className="text-body-13 leading-[1.5]! text-ink-4 mt-2.5 mx-1">
              Windows Defender may prompt the first time another device tries to connect — allow
              access on private networks.
            </p>

            <Banner variant="warn">
              <span>
                <b className="block font-medium text-ink">
                  LAN exposes this dashboard beyond your machine
                </b>
                Anyone on the same Wi-Fi can attempt to reach the URL above. Keep email + password
                auth enabled and avoid open / public networks.
              </span>
            </Banner>
          </>
        )}

        {bind === 'lan' && initial.lanAddresses.length === 0 && (
          <Banner variant="warn">
            No LAN interface detected. Make sure this machine is connected to a network before
            enabling LAN access.
          </Banner>
        )}

        {!initial.configPathExists && (
          <Banner variant="warn">
            <b className="block font-medium text-ink">Config file missing</b>
            ~/.nodalai/config.json wasn&apos;t found. Save will fail until you&apos;ve run{' '}
            <code className="text-mono-12">nodal-agents init</code> at least once.
          </Banner>
        )}

        {authAlignedHint && (
          <Banner variant="info" title="Sign-in enabled.">
            LAN access requires email + password auth, so it was switched on. After the restart, the
            login page will ask you to create your account. Your agents and settings are kept.
          </Banner>
        )}

        {restartHint && (
          <Banner variant="info" title="Saved. Restart required.">
            Run <code className="text-mono-12">nodal-agents down && nodal-agents up</code> to
            activate the new network mode.
          </Banner>
        )}

        <SetCtaRow onCancel={handleReset} pending={isPending} />
      </SetForm>
    </form>
  );
}
