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
        <legend className="block text-xs text-neutral-500 mb-2">Network access</legend>
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
        <div className="bg-neutral-950 border border-neutral-800/40 rounded-lg p-4 space-y-2">
          <div className="text-xs text-neutral-500">
            From your phone or another device on the same network, open:
          </div>
          <ul className="space-y-1.5">
            {initial.lanAddresses.map((ip) => {
              const url = `http://${ip}:${initial.webPort}`;
              return (
                <li key={ip} className="flex items-center justify-between gap-3">
                  <code className="font-mono text-sm text-white break-all">{url}</code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(url)}
                    className="px-2 py-1 text-[11px] font-medium border border-neutral-800 text-neutral-400 rounded hover:border-neutral-700 hover:text-white shrink-0"
                  >
                    Copy
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-neutral-600 pt-1">
            Windows Defender may prompt the first time another device tries to connect — allow
            access on private networks.
          </p>
        </div>
      )}

      {bind === 'lan' && initial.lanAddresses.length === 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 text-xs text-amber-300">
          No LAN interface detected. Make sure this machine is connected to a network before
          enabling LAN access.
        </div>
      )}

      {!initial.configPathExists && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 text-xs text-amber-300">
          ~/.nodalai/config.json wasn&apos;t found. Save here will fail until you&apos;ve run{' '}
          <code className="font-mono">nodalai init</code> at least once.
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
        {driftFromRuntime && (
          <span className="text-xs text-amber-400">
            New bind <code className="font-mono">{bind}</code> requires{' '}
            <code className="font-mono">nodalai down && nodalai up</code> to take effect.
          </span>
        )}
      </div>

      {restartHint && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3 py-2 text-xs text-emerald-300">
          Saved. Restart with <code className="font-mono">nodalai down && nodalai up</code> to
          activate the new network mode.
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
        checked
          ? 'border-violet-500/50 bg-violet-500/5'
          : 'border-neutral-800 hover:border-neutral-700'
      }`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="mt-1 accent-violet-500"
      />
      <div>
        <div className="text-sm text-white">{label}</div>
        <div className="text-xs text-neutral-500">{subtitle}</div>
      </div>
    </label>
  );
}
