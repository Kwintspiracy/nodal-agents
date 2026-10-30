'use client';

/**
 * SandboxSection — Réglages → Safety → Sandbox (#876), en tête de la page,
 * d'après la maquette validée le 27/10 (carte d'état, trois cases de
 * périmètre, dossiers permis, dossiers des agents).
 *
 * Ce que le bac à sable EST sur cette machine pour cet espace, tel que le
 * runner le dit (GET /api/sandbox, lu par `getSandboxAction`) : son état, son
 * moteur, ses limites, et son périmètre en vrais chemins. La section ne
 * recalcule rien — le regroupement des dossiers par agent, le compte des
 * dossiers inscriptibles et la place des commandes de chaque runtime viennent
 * de la route — ; elle traduit des codes en phrases (`lib/sandbox-copy.ts`).
 *
 * Trois gestes, réservés au propriétaire de l'espace :
 *   - l'interrupteur. Le couper demande une confirmation qui dit la
 *     conséquence ; le rallumer n'en demande pas (confiner est toujours sûr).
 *     L'effet est immédiat : le runner relit le réglage à chaque commande ;
 *   - ajouter un dossier permis (le sélecteur de dossiers du serveur). Une
 *     racine de volume ou le dossier personnel demandent une confirmation qui
 *     nomme la conséquence ; le dossier de données de Nodal est refusé, dit en
 *     ligne, avec le code de la règle du bac à sable ;
 *   - retirer un dossier détecté, ou le rétablir. Le cache d'outils reste.
 *
 * Sur un système sans moteur (`SANDBOX_NOT_IMPLEMENTED`), rien ne fait
 * semblant de marcher : les contrôles sont éteints et la section dit pourquoi.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  EyeSlash,
  FolderSimple,
  Globe,
  Lock,
  PencilSimple,
  Plus,
  Shield,
  ShieldCheck,
  ShieldSlash,
  Warning,
  X,
} from '@phosphor-icons/react';
import type { BroadFolder, SandboxAgent } from '@nodal-agents/shared';
import {
  addSandboxFolderAction,
  removeSandboxFolderAction,
  restoreSandboxFolderAction,
  setSandboxEnabledAction,
  type SandboxView,
} from '@/lib/sandbox-actions.ts';
import {
  AGENT_FOLDERS_LEDE,
  ALSO_WRITABLE,
  ALWAYS_ON,
  EVERY_AGENT,
  LIMITS_TITLE,
  REMOVED_BY_YOU,
  TOOL_CACHE_NOTE,
  TURN_OFF_WORDS,
  allowedFoldersLede,
  broadFolderWords,
  folderTag,
  limitWords,
  limitsToggleWords,
  nodalDataRefusalWords,
  notOnThisSystem,
  outsideSandboxWords,
  perimeterWords,
  sandboxRegime,
  splitFolder,
  stateCardWords,
  withoutFolderWords,
} from '@/lib/sandbox-copy.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import AgentPill from '@/components/ui/AgentPill';
import Banner from '@/components/ui/Banner';
import CountPill from '@/components/ui/CountPill';
import DisclosureButton from '@/components/ui/DisclosureButton';
import Disc from '@/components/ui/Disc';
import EdRow from '@/components/ui/EdRow';
import IconButton from '@/components/ui/IconButton';
import MetricCard from '@/components/ui/MetricCard';
import MonoCode from '@/components/ui/MonoCode';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Switch from '@/components/ui/Switch';
import { TagMini } from '@/components/ui/TagMini';
import FolderPickerModal from '@/app/(dashboard)/agents/[id]/edit/FolderPickerModal.tsx';

interface Props {
  initial: SandboxView;
}

const CARD = 'overflow-hidden rounded-2xl border border-rule-2 bg-paper';
const CARD_HEAD = 'flex items-center gap-3 px-5 pt-4 pb-3';
const FOOT = 'border-t border-rule-2 bg-canvas/40 px-5';
const CAPS = 'text-mono-11 uppercase tracking-[0.14em] text-ink-4';

export default function SandboxSection({ initial }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [confirmOff, setConfirmOff] = useState(false);
  const [picking, setPicking] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [broad, setBroad] = useState<{ path: string; folder: BroadFolder } | null>(null);
  const [refusal, setRefusal] = useState<{ path: string; within: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const unsupported = notOnThisSystem(initial);
  const view = { ...initial, enabled };
  const regime = sandboxRegime(view);
  const card = stateCardWords(view);
  const perimeter = perimeterWords(view);
  const controlsOff = !initial.isOwner || unsupported || pending;
  const limits = initial.status.state === 'available' ? (initial.status.limits ?? []) : [];

  function applySwitch(next: boolean) {
    setEnabled(next);
    startTransition(async () => {
      const r = await setSandboxEnabledAction({ enabled: next });
      if (!r.ok) {
        setEnabled(!next);
        toast.error(r.message);
        return;
      }
      toast.success(
        next
          ? 'Sandbox on. The next command of this workspace is confined.'
          : 'Sandbox off. The next command of this workspace runs without confinement.',
      );
      router.refresh();
    });
  }

  function add(path: string, confirmedBroad = false) {
    setRefusal(null);
    startTransition(async () => {
      const r = await addSandboxFolderAction({ path, confirmedBroad });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (r.data.kind === 'confirm') {
        setBroad({ path, folder: r.data.broad });
        return;
      }
      if (r.data.kind === 'refused') {
        setRefusal({ path, within: r.data.within });
        return;
      }
      toast.success(r.data.kind === 'restored' ? 'Folder allowed again.' : 'Folder allowed.');
      router.refresh();
    });
  }

  function change(action: typeof removeSandboxFolderAction, path: string) {
    startTransition(async () => {
      const r = await action({ path });
      if (!r.ok) toast.error(r.message);
      else router.refresh();
    });
  }

  const inForce = initial.allowedFolders.filter((f) => f.state !== 'removed');
  const removed = initial.allowedFolders.filter((f) => f.state === 'removed');
  const counted = initial.allowedFolders.filter((f) => f.state === 'allowed').map((f) => f.path);

  // Les agents dont les commandes ne passent pas par ce bac à sable, une fois
  // chacun, d'après ce que le runner rapporte (`commands`).
  const escaping = new Map<string, SandboxAgent>();
  for (const a of [
    ...initial.agentFolders.flatMap((g) => g.agents),
    ...initial.agentsWithoutFolder,
  ]) {
    if (a.commands !== 'sandbox') escaping.set(a.id, a);
  }

  return (
    <div className="flex flex-col gap-3" data-testid="sandbox-section">
      {/* ── La carte d'état ─────────────────────────────────────────────── */}
      <div
        className={`overflow-hidden rounded-2xl border bg-paper ${regime === 'off' ? 'border-warn/40' : 'border-rule-2'}`}
        data-testid="sandbox-state-card"
        data-regime={regime}
      >
        <div className="flex items-center gap-4 px-5 py-5">
          <Disc
            variant={regime === 'active' ? 'agent' : regime === 'off' ? 'warn' : 'neutral'}
            size="xxl"
            shape="square"
          >
            {regime === 'active' ? (
              <ShieldCheck />
            ) : regime === 'off' ? (
              <ShieldSlash />
            ) : (
              <Shield />
            )}
          </Disc>
          <div className="min-w-0 flex-1">
            <div className="text-title-16 text-ink" data-testid="sandbox-state-title">
              {card.title}
            </div>
            <p className="mt-0.5 text-body-13 text-ink-3">{card.body}</p>
            {!initial.isOwner && !unsupported && (
              <p className="mt-1 text-body-12 text-ink-4">
                Only the workspace owner can change the sandbox.
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {!unsupported && <MonoMicroTag tone="ink">owner only</MonoMicroTag>}
            <Switch
              checked={enabled && !unsupported}
              disabled={controlsOff}
              ariaLabel={
                unsupported
                  ? 'Sandbox for this workspace, not available on this system'
                  : 'Sandbox for this workspace'
              }
              onChange={() => {
                if (enabled) setConfirmOff(true);
                else applySwitch(true);
              }}
            />
          </div>
        </div>
        <div
          className={`flex flex-wrap items-center gap-x-5 gap-y-2 py-2.5 text-body-12 text-ink-3 ${FOOT}`}
          data-testid="sandbox-state-facts"
        >
          <span>
            <span className={CAPS}>Engine</span>{' '}
            <span className="font-mono text-ink-2">{card.engine}</span>
          </span>
          {card.applies && (
            <span>
              <span className={CAPS}>Applies</span>{' '}
              <span className="text-ink-2">{card.applies}</span>
            </span>
          )}
          {card.results && (
            <span>
              <span className={CAPS}>Results</span>{' '}
              <span className="font-mono text-ink-2">{card.results}</span>
            </span>
          )}
          {regime === 'active' && limits.length > 0 && (
            <span className="ml-auto">
              <DisclosureButton
                open={limitsOpen}
                onClick={() => setLimitsOpen((o) => !o)}
                chevron="end"
                inset="none"
                insetY="none"
                testId="sandbox-limits-toggle"
              >
                <span className="text-body-12 text-ink-2">{limitsToggleWords(limits.length)}</span>
              </DisclosureButton>
            </span>
          )}
        </div>
      </div>

      {limitsOpen && regime === 'active' && (
        <div className={CARD} data-testid="sandbox-limits">
          <div className="border-b border-rule-2 px-5 py-3 text-title-13 text-ink">
            {LIMITS_TITLE}
          </div>
          <ul className="divide-y divide-rule-2">
            {limits.map((l) => {
              const { code, words, detail } = limitWords(l);
              return (
                <li key={code} className="flex flex-col gap-1 px-5 py-3" title={detail}>
                  <span className="text-body-13 text-ink-2">{words}</span>
                  <span className="text-mono-11 text-ink-4">{code}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── Le périmètre ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="sandbox-perimeter">
        <MetricCard
          label="Can write"
          icon={<PencilSimple size={14} />}
          value={perimeter.write.value}
          subtle={perimeter.write.subtle}
          tone={perimeter.write.tone}
          {...(regime === 'active' ? { href: '#sandbox-agent-folders' } : {})}
        />
        <MetricCard
          label="Cannot read"
          icon={<EyeSlash size={14} />}
          value={perimeter.read.value}
          subtle={perimeter.read.subtle}
          tone={perimeter.read.tone}
        >
          {regime === 'active' &&
            initial.readRefused.map((p) => (
              <MonoCode key={p} className="max-w-full truncate">
                <span title={p}>{p}</span>
              </MonoCode>
            ))}
        </MetricCard>
        <MetricCard
          label="Network"
          icon={<Globe size={14} />}
          value={perimeter.network.value}
          subtle={perimeter.network.subtle}
          tone={perimeter.network.tone}
        >
          {regime === 'active' &&
            ('deniedPorts' in initial.network
              ? initial.network.deniedPorts.map((p) => <MonoCode key={p}>{p}</MonoCode>)
              : [<MonoCode key="code">{initial.network.code}</MonoCode>])}
        </MetricCard>
      </div>

      {/* ── Les dossiers permis ─────────────────────────────────────────── */}
      <div className={CARD} data-testid="sandbox-allowed-folders">
        <div className={CARD_HEAD}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className={`text-title-15 ${unsupported ? 'text-ink-3' : 'text-ink'}`}>
                Allowed folders
              </h3>
              {!unsupported && <CountPill items={counted} noun="folder" />}
            </div>
            <p className="mt-0.5 text-body-13 text-ink-3">
              {allowedFoldersLede(regime, unsupported)}
            </p>
          </div>
          <PrimaryButton
            variant={regime === 'active' ? 'ink' : 'neutral'}
            size="sm"
            disabled={controlsOff}
            onClick={() => setPicking(true)}
          >
            <Plus size={14} weight="bold" />
            Add folder
          </PrimaryButton>
        </div>

        {refusal && (
          <div className="px-5 pb-3" data-testid="sandbox-refusal">
            <Banner
              variant="warn"
              role="alert"
              action={
                <IconButton ghost aria-label="Dismiss" onClick={() => setRefusal(null)}>
                  <X size={14} />
                </IconButton>
              }
            >
              {nodalDataRefusalWords(refusal.path, refusal.within, initial.platform)}
            </Banner>
          </div>
        )}

        {!unsupported && (
          <ul>
            {inForce.map((f) => {
              const { name, parent } = splitFolder(f.path);
              const tag = folderTag(f);
              const off = regime !== 'active';
              const alert = f.state === 'missing' || f.state === 'refused';
              return (
                <li
                  key={`${f.source}:${f.path}`}
                  data-testid="sandbox-allowed-folder"
                  data-state={f.state}
                >
                  <EdRow
                    frame="list"
                    dimmed={off}
                    glyph={
                      <Disc variant={alert ? 'warn' : 'neutral'} size="sm" shape="square">
                        {alert ? <Warning /> : <FolderSimple />}
                      </Disc>
                    }
                    name={name}
                    description={<FolderParent parent={parent} path={f.path} />}
                    {...(off
                      ? {}
                      : {
                          meta: <TagMini variant={tag.variant}>{tag.label}</TagMini>,
                          actions: (
                            <span className="flex w-[104px] justify-end">
                              {f.source === 'tool-cache' ? (
                                <span
                                  className="inline-flex items-center gap-1 text-body-12 text-ink-3"
                                  title={TOOL_CACHE_NOTE}
                                >
                                  <Lock size={13} />
                                  {ALWAYS_ON}
                                </span>
                              ) : (
                                <PrimaryButton
                                  variant="neutral"
                                  size="sm"
                                  disabled={controlsOff}
                                  onClick={() => change(removeSandboxFolderAction, f.path)}
                                >
                                  Remove
                                </PrimaryButton>
                              )}
                            </span>
                          ),
                        })}
                  />
                </li>
              );
            })}
          </ul>
        )}

        {!unsupported && regime === 'active' && removed.length > 0 && (
          <div className="bg-canvas/40" data-testid="sandbox-removed-folders">
            <div className={`border-t border-rule-2 px-5 pt-2.5 pb-1 ${CAPS}`}>
              {REMOVED_BY_YOU}
            </div>
            <ul>
              {removed.map((f) => {
                const { name, parent } = splitFolder(f.path);
                const tag = folderTag(f);
                return (
                  <li
                    key={`${f.source}:${f.path}`}
                    data-testid="sandbox-allowed-folder"
                    data-state={f.state}
                  >
                    <EdRow
                      frame="list"
                      glyph={
                        <Disc variant="outline" size="sm" shape="square">
                          <FolderSimple />
                        </Disc>
                      }
                      name={<span className="text-ink-3">{name}</span>}
                      description={<FolderParent parent={parent} path={f.path} />}
                      meta={<TagMini variant={tag.variant}>{tag.label}</TagMini>}
                      actions={
                        <span className="flex w-[104px] justify-end">
                          <PrimaryButton
                            variant="neutral"
                            size="sm"
                            disabled={controlsOff}
                            onClick={() => change(restoreSandboxFolderAction, f.path)}
                          >
                            Allow again
                          </PrimaryButton>
                        </span>
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* ── Les dossiers des agents (seulement quand le bac à sable confine) ── */}
      {regime === 'active' && (
        <div id="sandbox-agent-folders" className={CARD} data-testid="sandbox-agent-folders">
          <div className={CARD_HEAD}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-title-15 text-ink">Agent folders</h3>
                <CountPill
                  items={[
                    ...initial.agentFolders.map((g) => g.path),
                    ...(initial.sharedFolder ? [initial.sharedFolder] : []),
                  ]}
                  noun="folder"
                />
              </div>
              <p className="mt-0.5 text-body-13 text-ink-3">{AGENT_FOLDERS_LEDE}</p>
            </div>
          </div>
          <ul>
            {initial.agentFolders.map((g) => {
              const { name, parent } = splitFolder(g.path);
              return (
                <li key={g.path} data-testid="sandbox-agent-folder">
                  <EdRow
                    frame="list"
                    glyph={
                      <Disc variant="neutral" size="sm" shape="square">
                        <FolderSimple />
                      </Disc>
                    }
                    name={name}
                    description={<FolderParent parent={parent} path={g.path} />}
                    actions={
                      <span className="flex flex-wrap justify-end gap-1.5">
                        {g.agents.map((a) => {
                          const why = outsideSandboxWords(a);
                          return (
                            <AgentPill
                              key={a.id}
                              name={a.name}
                              href={`/agents/${a.id}/edit`}
                              size="sm"
                              {...(why
                                ? {
                                    tone: 'warn' as const,
                                    title: why,
                                    trailing: <Warning size={13} />,
                                  }
                                : {})}
                            />
                          );
                        })}
                      </span>
                    }
                  />
                </li>
              );
            })}
            {initial.sharedFolder && (
              <li data-testid="sandbox-shared-folder">
                <EdRow
                  frame="list"
                  glyph={
                    <Disc variant="neutral" size="sm" shape="square">
                      <FolderSimple />
                    </Disc>
                  }
                  name={splitFolder(initial.sharedFolder).name}
                  description={
                    <FolderParent
                      parent={splitFolder(initial.sharedFolder).parent}
                      path={initial.sharedFolder}
                    />
                  }
                  meta={<TagMini variant="neutral">{EVERY_AGENT}</TagMini>}
                />
              </li>
            )}
          </ul>
          <div
            className={`flex flex-col gap-1.5 py-3 text-body-12 text-ink-3 ${FOOT}`}
            data-testid="sandbox-agent-folders-notes"
          >
            <span>{ALSO_WRITABLE}</span>
            {initial.agentsWithoutFolder.length > 0 && (
              <span>{withoutFolderWords(initial.agentsWithoutFolder.map((a) => a.name))}</span>
            )}
            {[...escaping.values()].map((a) => (
              <span key={a.id} className="flex items-center gap-1.5 text-warn">
                <Warning size={13} />
                {outsideSandboxWords(a)}
              </span>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOff}
        title={TURN_OFF_WORDS.title}
        message={TURN_OFF_WORDS.message}
        confirmLabel={TURN_OFF_WORDS.confirm}
        destructive
        onConfirm={() => {
          setConfirmOff(false);
          applySwitch(false);
        }}
        onCancel={() => setConfirmOff(false)}
      />

      {broad && (
        <ConfirmDialog
          open
          title={broadFolderWords(broad.folder, broad.path, initial.platform).title}
          message={broadFolderWords(broad.folder, broad.path, initial.platform).message}
          confirmLabel={broadFolderWords(broad.folder, broad.path, initial.platform).confirm}
          destructive
          onConfirm={() => {
            const { path } = broad;
            setBroad(null);
            add(path, true);
          }}
          onCancel={() => setBroad(null)}
        />
      )}

      <FolderPickerModal
        open={picking}
        onClose={() => setPicking(false)}
        onSelect={(path) => {
          setPicking(false);
          add(path);
        }}
      />
    </div>
  );
}

/** Le dossier parent, en mono ; le chemin complet au survol. */
function FolderParent({ parent, path }: { parent: string; path: string }) {
  return (
    <span className="font-mono text-mono-12" title={path}>
      {parent || path}
    </span>
  );
}
