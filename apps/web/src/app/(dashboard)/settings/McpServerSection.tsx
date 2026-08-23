'use client';

/**
 * McpServerSection — l'interrupteur maître du serveur MCP, et la seule trace
 * visible de son existence dans le produit.
 *
 * Le serveur MCP (PR C) laisse un client externe — le terminal du
 * propriétaire, un agent codeur — confier du travail à un agent Nodal via
 * `run_task`. Avant cette section, la porte était invisible : rien ne montrait
 * qu'elle existe, et la fermer exigeait de connaître chaque client configuré
 * sur la machine. Constat de Quentin (23/08), d'où : défaut FERMÉ, visible
 * ici, coupure effective sur les clients déjà connectés (le serveur revérifie
 * à chaque appel).
 *
 * Ce que la porte NE donne jamais, quel que soit l'interrupteur : les outils
 * de configuration. Les jobs `mcp` sont exclus des meta-ops au niveau du
 * runner — demander du travail, oui ; reconfigurer Nodal, non.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setMcpServerSwitchAction, type McpServerSwitchView } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import Switch from '@/components/ui/Switch';
import { SetUrl } from '@/components/ui/SetUrl.tsx';

/**
 * La commande complète, prête à coller. `nodal-agents mcp serve` résout
 * lui-même l'URL de la base depuis ~/.nodalai/config.json — l'utilisateur n'a
 * ni DATABASE_URL à connaître, ni secret à copier dans la config de son client
 * (l'ancienne commande documentée mettait le mot de passe Postgres en clair
 * dans la config MCP, et son `pnpm --filter` n'existait que dans le repo de dev).
 */
const MCP_CONNECT_COMMAND = 'claude mcp add nodal -- nodal-agents mcp serve';

interface Props {
  initial: McpServerSwitchView;
}

export default function McpServerSection({ initial }: Props) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  function apply(next: boolean) {
    startTransition(async () => {
      const res = await setMcpServerSwitchAction({ enabled: next });
      if (res.ok) {
        setEnabled(next);
        toast.success(next ? 'MCP server enabled' : 'MCP server disabled');
      } else {
        toast.error(res.message);
      }
    });
  }

  return (
    <div className="rounded-2xl border border-rule-2 bg-paper p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-medium-15 text-ink">MCP server</h2>
            <MonoMicroTag tone={enabled ? 'agent' : 'ink'}>{enabled ? 'on' : 'off'}</MonoMicroTag>
          </div>
          <p className="mt-1 text-body-13 leading-[1.5]! text-ink-3">
            Lets an external MCP client — your terminal, a coding agent — hand work to this
            workspace&apos;s root agent. Jobs arrive on the Runs page with channel <code>mcp</code>{' '}
            and the caller&apos;s self-chosen label. MCP jobs can never use the configuration tools
            (create agents, skills, connectors, automations) — that is enforced in the runner, not
            by this switch.
          </p>
          {enabled && (
            <>
              <SetUrl subtitle="Connect a client (Claude Code shown):" url={MCP_CONNECT_COMMAND} />
              <p className="mt-1.5 text-body-12 text-ink-4">
                Run it on the machine that hosts Nodal.
              </p>
            </>
          )}
          {!initial.isOwner && (
            <p className="mt-2 text-body-12 text-ink-4">
              Only the workspace owner can change this setting.
            </p>
          )}
        </div>
        <Switch
          checked={enabled}
          disabled={pending || !initial.isOwner}
          onChange={() => {
            if (!enabled) setConfirming(true);
            else apply(false);
          }}
          trackClassName={enabled ? 'border-agent/40 bg-agent/20' : 'border-rule-2 bg-canvas'}
          thumbClassName={enabled ? 'translate-x-[18px] bg-agent' : 'translate-x-[2px] bg-ink-3'}
        />
      </div>

      <ConfirmDialog
        open={confirming}
        title="Enable the MCP server?"
        message={
          'Any process on this machine that knows the database URL will be able to hand work ' +
          'to your root agent — under its approval rules and budgets, and never with the ' +
          'configuration tools. Turning this off later also cuts clients that are already ' +
          'connected.'
        }
        confirmLabel="Enable"
        onConfirm={() => {
          setConfirming(false);
          apply(true);
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
