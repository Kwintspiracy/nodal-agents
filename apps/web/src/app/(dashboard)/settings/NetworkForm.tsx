'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateNetworkSettingsAction, type NetworkView } from '@/lib/actions.ts';

interface Props {
  initial: NetworkView;
}

export default function NetworkForm({ initial }: Props) {
  const [bind, setBind] = useState<'loopback' | 'lan'>(initial.configuredBind);
  const [isPending, startTransition] = useTransition();
  const [restartHint, setRestartHint] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const r = await updateNetworkSettingsAction({ bind });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Network settings saved');
        setRestartHint(r.data.requiresRestart);
      }
    });
  }

  const driftFromRuntime = bind !== initial.runtimeBind;

  async function copyToClipboard(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="block text-xs text-ink-3 mb-2">Network access</legend>
        <Choice
          checked={bind === 'loopback'}
          onChange={() => setBind('loopback')}
          label="Local only (127.0.0.1)"
          subtitle="Only this machine can reach the dashboard. No auth required by default."
        />
        <Choice
          checked={bind === 'lan'}
          onChange={() => setBind('lan')}
          label="LAN (0.0.0.0) — accessible from your network"
          subtitle="Other devices on the same Wi-Fi can reach the dashboard. Sign-in required (local-auth)."
        />
      </fieldset>

      {bind === 'lan' && initial.lanAddresses.length > 0 && (
        <div className="bg-canvas border border-rule-2 rounded-lg p-4 space-y-2">
          <div className="text-xs text-ink-3">
            From your phone or another device on the same network, open:
          </div>
          <ul className="space-y-1.5">
            {initial.lanAddresses.map((ip) => {
              const url = `http://${ip}:${initial.webPort}`;
              return (
                <li key={ip} className="flex items-center justify-between gap-3">
                  <code className="font-mono text-sm text-ink break-all">{url}</code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(url)}
                    className="px-2 py-1 text-[11px] font-medium border border-rule-2 text-ink-3 rounded hover:border-rule hover:text-ink shrink-0"
                  >
                    Copy
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-ink-4 pt-1">
            Windows Defender may prompt the first time another device tries to connect — allow
            access on private networks.
          </p>
        </div>
      )}

      {bind === 'lan' && initial.lanAddresses.length === 0 && (
        <div className="bg-warn-bg border border-warn/30 rounded-md px-3 py-2 text-xs text-warn">
          No LAN interface detected. Make sure this machine is connected to a network before
          enabling LAN access.
        </div>
      )}

      {!initial.configPathExists && (
        <div className="bg-warn-bg border border-warn/30 rounded-md px-3 py-2 text-xs text-warn">
          ~/.nodalai/config.json wasn&apos;t found. Save here will fail until you&apos;ve run{' '}
          <code className="font-mono">nodal-agents init</code> at least once.
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
        {driftFromRuntime && (
          <span className="text-xs text-warn">
            New bind <code className="font-mono">{bind}</code> requires{' '}
            <code className="font-mono">nodal-agents down && nodal-agents up</code> to take effect.
          </span>
        )}
      </div>

      {restartHint && (
        <div className="bg-agent-vivid/10 border border-ok/30 rounded-md px-3 py-2 text-xs text-ok">
          Saved. Restart with{' '}
          <code className="font-mono">nodal-agents down && nodal-agents up</code> to activate the
          new network mode.
        </div>
      )}
    </form>
  );
}

function Choice({
  checked,
  onChange,
  label,
  subtitle,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  subtitle: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 px-3 py-2 rounded-md cursor-pointer border ${
        checked ? 'border-run/30 bg-run-bg' : 'border-rule-2 hover:border-rule'
      }`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="mt-1 accent-violet-500"
      />
      <div>
        <div className="text-sm text-ink">{label}</div>
        <div className="text-xs text-ink-3">{subtitle}</div>
      </div>
    </label>
  );
}
