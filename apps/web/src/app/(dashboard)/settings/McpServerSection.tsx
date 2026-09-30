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
import {
  addNodalToClaudeDesktopAction,
  setMcpServerSwitchAction,
  type McpServerSwitchView,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import Switch from '@/components/ui/Switch';
import PrimaryButton from '@/components/ui/PrimaryButton';
import CodeBlock from '@/components/ui/CodeBlock';
import { SetUrl } from '@/components/ui/SetUrl.tsx';
import { MCP_MAX_JOBS_IN_FLIGHT } from '@nodal-agents/shared';

// #485 — DEUX CLIENTS À LA FOIS. Le serveur est en stdio : Claude Code et
// Claude Desktop lancent chacun leur processus contre la même base, et leurs
// travaux arrivent sur la même page Runs. La carte donne le texte exact de
// chacun, bâti pour CETTE install à partir de la commande du CLI qui a démarré
// la stack (`lib/mcp-clients.ts`). `nodal-agents mcp serve` écrit à la main ne
// marchait ni sur un poste de dev ni sur une install lancée par npx. Aucun
// secret n'y figure : `mcp serve` relit lui-même ~/.nodalai/config.json.

interface Props {
  initial: McpServerSwitchView;
}

export default function McpServerSection({ initial }: Props) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [confirming, setConfirming] = useState(false);
  const [addingDesktop, setAddingDesktop] = useState(false);
  const [pending, startTransition] = useTransition();
  const clients = initial.clients;

  function addToDesktop() {
    startTransition(async () => {
      const res = await addNodalToClaudeDesktopAction();
      if (res.ok) toast.success('Added to Claude Desktop. Restart it to connect.');
      else toast.error(res.message);
    });
  }

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
            Lets a program on this computer (your terminal, a coding agent) hand work to an agent of
            this workspace: the root agent, unless the caller names another. Nothing is opened to
            the network. Jobs arrive on the Runs page with channel <code>mcp</code> and the label
            the caller gives. MCP jobs never get the configuration tools (create agents, skills,
            connectors, automations); the runner enforces that, not this switch. At most{' '}
            {MCP_MAX_JOBS_IN_FLIGHT} MCP jobs run at once; a finished one frees its place.
          </p>
          {enabled && clients === null && (
            <p className="mt-3 text-body-12 text-ink-4">
              Start Nodal with nodal-agents up to see the command for your MCP clients.
            </p>
          )}
          {enabled && clients !== null && (
            <>
              <p className="mt-3 text-body-12 text-ink-4">
                Both can be connected at the same time. Set them up on the machine that hosts Nodal.
              </p>
              <div data-testid="mcp-client-claude-code">
                <SetUrl subtitle="Claude Code: run this command" url={clients.claudeCode} />
              </div>
              <div data-testid="mcp-client-claude-desktop" className="mt-4">
                <p className="text-body-13 text-ink-2">
                  Claude Desktop: add this to {clients.claudeDesktopPath}
                </p>
                <CodeBlock code={clients.claudeDesktop} lang="json" className="mt-2" />
                {initial.isOwner && (
                  <PrimaryButton
                    variant="neutral"
                    size="sm"
                    className="mt-2"
                    disabled={pending}
                    onClick={() => setAddingDesktop(true)}
                  >
                    Add to Claude Desktop
                  </PrimaryButton>
                )}
              </div>
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
        />
      </div>

      <ConfirmDialog
        open={confirming}
        title="Enable the MCP server?"
        message={
          'Any program on this machine that can read Nodal’s settings or knows its database URL ' +
          'will be able to hand work to an agent of this workspace: the root agent, unless it ' +
          'names another. The work runs under that agent’s approval rules and budget, and never ' +
          'with the configuration tools. Turning this off later also cuts clients that are ' +
          'already connected.'
        }
        confirmLabel="Enable"
        onConfirm={() => {
          setConfirming(false);
          apply(true);
        }}
        onCancel={() => setConfirming(false)}
      />

      {clients !== null && (
        <ConfirmDialog
          open={addingDesktop}
          title="Add Nodal to Claude Desktop?"
          message={
            `This writes the entry below into ${clients.claudeDesktopPath}. Its other servers are ` +
            'kept, and the file is backed up first. The entry holds no password. Restart Claude ' +
            'Desktop afterwards to connect it.'
          }
          extra={<CodeBlock code={clients.claudeDesktop} lang="json" className="mt-3" />}
          confirmLabel="Add"
          destructive={false}
          onConfirm={() => {
            setAddingDesktop(false);
            addToDesktop();
          }}
          onCancel={() => setAddingDesktop(false)}
        />
      )}
    </div>
  );
}
