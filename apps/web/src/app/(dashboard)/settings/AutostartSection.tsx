'use client';

// AutostartSection — « Start Nodal when this machine starts » (#451).
//
// Une machine qui redémarre laissait Nodal éteint : plus d'automatisation, plus
// de canal, jusqu'à ce que quelqu'un ouvre un terminal. L'interrupteur inscrit
// Nodal auprès du démarrage NATIF du système, par le CLI (`nodal-agents service
// install | uninstall`) : tâche planifiée sous Windows, LaunchAgent sous macOS,
// unité systemd utilisateur sous Linux.
//
// Ce que la ligne montre est lu dans le SYSTÈME à chaque affichage, jamais un
// drapeau stocké : une inscription retirée à la main se lit « off ». Sous Linux
// sans « linger », Nodal ne démarre qu'à la connexion : la ligne le dit, avec la
// commande exacte qui le fait démarrer au boot.

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setAutostartAction } from '@/lib/actions.ts';
import type { AutostartView } from '@/lib/autostart-view.ts';
import Switch from '@/components/ui/Switch';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { SetUrl } from '@/components/ui/SetUrl.tsx';

function stateLine(view: AutostartView): string {
  const s = view.status;
  if (s === null) return view.error ?? 'How Nodal starts with this machine could not be read.';
  switch (s.state) {
    case 'off':
      return 'Off. After a restart, Nodal stays down until someone starts it.';
    case 'at_login':
      return 'On. Nodal starts when you log in to this machine.';
    case 'at_boot':
      return 'On. Nodal starts when this machine boots, before anyone logs in.';
    case 'unsupported':
      return s.reason;
  }
}

export default function AutostartSection({ initial }: { initial: AutostartView }) {
  const [view, setView] = useState(initial);
  const [pending, startTransition] = useTransition();
  const s = view.status;
  const on = s?.state === 'at_login' || s?.state === 'at_boot';
  const usable = s !== null && s.state !== 'unsupported';

  function apply(next: boolean) {
    startTransition(async () => {
      const r = await setAutostartAction({ enabled: next });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setView(r.data);
      toast.success(
        next ? 'Nodal will start with this machine' : 'Nodal will not start with this machine',
      );
    });
  }

  return (
    <div className="rounded-2xl border border-rule-2 bg-paper p-6" data-testid="autostart-section">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-medium-15 text-ink">Start Nodal when this machine starts</h2>
            <MonoMicroTag tone={on ? 'agent' : 'ink'}>{on ? 'on' : 'off'}</MonoMicroTag>
          </div>
          <p className="mt-1 text-body-13 text-ink-3" data-testid="autostart-state">
            {stateLine(view)}
          </p>
          {s?.state === 'at_login' && s.lingerCommand !== undefined && (
            <SetUrl
              subtitle="To start it at boot, before anyone logs in, run this once:"
              url={s.lingerCommand}
            />
          )}
          {!view.isOwner && (
            <p className="mt-2 text-body-12 text-ink-4">
              Only the owner of this installation can change this setting.
            </p>
          )}
        </div>
        <Switch
          checked={on}
          disabled={pending || !view.isOwner || !usable}
          onChange={() => apply(!on)}
        />
      </div>
    </div>
  );
}
