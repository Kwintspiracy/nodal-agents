'use client';

/**
 * SandboxSection — Réglages → Safety → Sandbox (#876), en tête de la page.
 *
 * Ce que le bac à sable EST sur cette machine pour cet espace, tel que le
 * runner le dit (GET /api/sandbox, lu par `getSandboxAction`) : son état, son
 * backend, ses limites, et son périmètre en vrais chemins. La section ne
 * recalcule rien ; elle traduit des codes en phrases (`lib/sandbox-copy.ts`).
 *
 * Trois gestes, réservés au propriétaire de l'espace :
 *   - l'interrupteur. Le couper demande une confirmation qui dit la
 *     conséquence ; le rallumer n'en demande pas (confiner est toujours sûr).
 *     L'effet est immédiat : le runner relit le réglage à chaque commande ;
 *   - ajouter un dossier permis (le sélecteur de dossiers du serveur). Une
 *     racine de disque ou le dossier personnel demandent une confirmation qui
 *     nomme la conséquence ; le dossier de données de Nodal est refusé, avec
 *     la raison que l'action rend ;
 *   - retirer un dossier détecté, ou le rétablir. Le cache d'outils reste.
 *
 * Sur un système sans backend (`SANDBOX_NOT_IMPLEMENTED`), rien ne fait
 * semblant de marcher : les contrôles sont éteints et la section dit pourquoi.
 */

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  addSandboxFolderAction,
  removeSandboxFolderAction,
  restoreSandboxFolderAction,
  setSandboxEnabledAction,
  type SandboxView,
} from '@/lib/sandbox-actions.ts';
import {
  SOURCE_WORDS,
  TOOL_CACHE_NOTE,
  broadFolderWords,
  limitWords,
  notOnThisSystem,
  sandboxRegime,
  unavailableWords,
} from '@/lib/sandbox-copy.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Banner from '@/components/ui/Banner';
import MonoCode from '@/components/ui/MonoCode';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Switch from '@/components/ui/Switch';
import FolderPickerModal from '@/app/(dashboard)/agents/[id]/edit/FolderPickerModal.tsx';

interface Props {
  initial: SandboxView;
}

const REGIME_TAG = {
  active: { tone: 'ok', label: 'active' },
  off: { tone: 'warn', label: 'off' },
  unavailable: { tone: 'warn', label: 'unavailable' },
} as const;

const STATE_WORDS: Record<'allowed' | 'removed' | 'missing' | 'refused', string | null> = {
  allowed: null,
  removed: 'Removed',
  missing: 'Folder not found, ignored',
  refused: "Inside Nodal's data, refused",
};

export default function SandboxSection({ initial }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [confirmOff, setConfirmOff] = useState(false);
  const [picking, setPicking] = useState(false);
  const [broad, setBroad] = useState<{ path: string; kind: 'drive-root' | 'home' } | null>(null);
  const [pending, startTransition] = useTransition();

  const unsupported = notOnThisSystem(initial);
  const regime = sandboxRegime({ status: initial.status, enabled });
  const controlsOff = !initial.isOwner || unsupported || pending;

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
    startTransition(async () => {
      const r = await addSandboxFolderAction({ path, confirmedBroad });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (r.data.kind === 'confirm') {
        setBroad({ path, kind: r.data.broad });
        return;
      }
      toast.success(r.data.kind === 'restored' ? 'Folder allowed again.' : 'Folder allowed.');
      router.refresh();
    });
  }

  function remove(path: string) {
    startTransition(async () => {
      const r = await removeSandboxFolderAction({ path });
      if (!r.ok) toast.error(r.message);
      else router.refresh();
    });
  }

  function restore(path: string) {
    startTransition(async () => {
      const r = await restoreSandboxFolderAction({ path });
      if (!r.ok) toast.error(r.message);
      else router.refresh();
    });
  }

  const status = initial.status;
  const network = initial.network;

  return (
    <div className="flex flex-col gap-4" data-testid="sandbox-section">
      {/* L'interrupteur, et ce qu'il fait. */}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-medium-14 text-ink">Sandbox for this workspace</span>
            <MonoMicroTag tone={REGIME_TAG[regime].tone}>{REGIME_TAG[regime].label}</MonoMicroTag>
            <MonoMicroTag tone="err">owner only</MonoMicroTag>
          </div>
          <p className="mt-1 text-body-13 leading-[1.4]! text-ink-3">
            Commands your agents start can write only in their folders and the allowed folders
            below, and cannot read Nodal&apos;s data. Off, they run without confinement.
          </p>
          {!initial.isOwner && (
            <p className="mt-2 text-body-12 text-ink-4">
              Only the workspace owner can change the sandbox.
            </p>
          )}
        </div>
        <div className="mt-0.5">
          <Switch
            checked={enabled && !unsupported}
            disabled={controlsOff}
            ariaLabel="Sandbox for this workspace"
            onChange={() => {
              if (enabled) setConfirmOff(true);
              else applySwitch(true);
            }}
          />
        </div>
      </div>

      {unsupported && (
        <Banner variant="warn" title="Not available on this system yet">
          Nodal has no sandbox for this system yet, so commands run without confinement and these
          controls are off.
        </Banner>
      )}
      {!unsupported && regime === 'off' && (
        <Banner variant="warn" title="The sandbox is off">
          Commands of this workspace run without confinement. Turn it back on to confine the next
          one.
        </Banner>
      )}

      {/* L'état, tel que la sonde l'a dit. */}
      <dl
        className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-body-13"
        data-testid="sandbox-state"
      >
        <dt className="text-ink-3">State</dt>
        <dd className="text-ink-2" data-testid="sandbox-state-value">
          {status.state === 'available' ? (
            enabled ? (
              'Active'
            ) : (
              'Available, turned off'
            )
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <span>Unavailable: {unavailableWords(status.code)}</span>
              <MonoCode>{status.code}</MonoCode>
            </span>
          )}
        </dd>
        {status.state === 'unavailable' && (
          <>
            <dt className="text-ink-3">Reason given</dt>
            <dd className="break-words text-ink-3">{status.reason}</dd>
          </>
        )}
        {status.state === 'available' && (
          <>
            <dt className="text-ink-3">Backend</dt>
            <dd>
              <MonoCode>{status.backend}</MonoCode>
            </dd>
            <dt className="text-ink-3">Limits</dt>
            <dd className="text-ink-2">
              {(status.limits ?? []).length === 0 ? (
                'None declared'
              ) : (
                <ul className="flex flex-col gap-1.5" data-testid="sandbox-limits">
                  {(status.limits ?? []).map((l) => {
                    const { code, words } = limitWords(l);
                    return (
                      <li key={code} className="flex flex-col gap-0.5">
                        <span>{words}</span>
                        <span className="text-mono-12 text-ink-4">{code}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </dd>
          </>
        )}
      </dl>

      {/* Le périmètre, en vrais chemins. */}
      <div className="flex flex-col gap-3" data-testid="sandbox-perimeter">
        <h3 className="text-medium-14 text-ink">Where a command can write</h3>
        <ul className="flex flex-col gap-2 text-body-13" data-testid="sandbox-agent-folders">
          {initial.agents.map((a) => (
            <li key={a.id} className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                <Link
                  href={`/agents/${a.id}/edit`}
                  className="text-medium-13 text-ink underline-offset-2 hover:underline"
                >
                  {a.name}
                </Link>
                {a.runtime !== 'nodal' && (
                  <span className="text-body-12 text-ink-4">
                    Runs its own coding CLI, outside this sandbox.
                  </span>
                )}
              </span>
              {a.folders.length === 0 ? (
                <span className="text-body-12 text-ink-4">No folder of its own</span>
              ) : (
                <span className="flex flex-wrap gap-1.5">
                  {a.folders.map((f) => (
                    <MonoCode key={f.path}>{f.path}</MonoCode>
                  ))}
                </span>
              )}
            </li>
          ))}
          <li className="flex flex-col gap-1">
            <span className="text-medium-13 text-ink">Every agent</span>
            <span className="text-body-12 text-ink-3">
              The shared folder, the folder attached to a request for that run, and a temporary
              folder of its own.
            </span>
            {initial.sharedFolder && (
              <span>
                <MonoCode>{initial.sharedFolder}</MonoCode>
              </span>
            )}
          </li>
        </ul>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-medium-14 text-ink">Allowed folders</h3>
            <PrimaryButton
              variant="neutral"
              size="sm"
              disabled={controlsOff}
              onClick={() => setPicking(true)}
            >
              Add folder
            </PrimaryButton>
          </div>
          <p className="text-body-12 text-ink-4">
            Every command of this workspace can write here too. Detected stores appear on their own.
          </p>
          <ul
            className="flex flex-col divide-y divide-rule-2 rounded-lg border border-rule-2"
            data-testid="sandbox-allowed-folders"
          >
            {initial.allowedFolders.map((f) => {
              const note = STATE_WORDS[f.state];
              return (
                <li
                  key={`${f.source}:${f.path}`}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                  data-testid="sandbox-allowed-folder"
                  data-state={f.state}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className={f.state === 'allowed' ? '' : 'opacity-60'}>
                      <MonoCode className="break-all">{f.path}</MonoCode>
                    </span>
                    <span className="text-body-12 text-ink-4">
                      {SOURCE_WORDS[f.source]}
                      {note ? `. ${note}` : ''}
                      {f.source === 'tool-cache' ? `. ${TOOL_CACHE_NOTE}` : ''}
                    </span>
                  </div>
                  {f.source !== 'tool-cache' &&
                    (f.state === 'removed' ? (
                      <PrimaryButton
                        variant="neutral"
                        size="sm"
                        disabled={controlsOff}
                        onClick={() => restore(f.path)}
                      >
                        Allow again
                      </PrimaryButton>
                    ) : (
                      <PrimaryButton
                        variant="neutral"
                        size="sm"
                        disabled={controlsOff}
                        onClick={() => remove(f.path)}
                      >
                        Remove
                      </PrimaryButton>
                    ))}
                </li>
              );
            })}
          </ul>
        </div>

        <h3 className="text-medium-14 text-ink">What a command cannot read</h3>
        <div className="flex flex-col gap-1 text-body-13" data-testid="sandbox-read-refused">
          <span className="text-body-12 text-ink-3">
            Nodal&apos;s data folder: its keys, its settings and its database.
          </span>
          <span className="flex flex-wrap gap-1.5">
            {initial.readRefused.map((p) => (
              <MonoCode key={p}>{p}</MonoCode>
            ))}
          </span>
        </div>

        <h3 className="text-medium-14 text-ink">Network</h3>
        <div className="flex flex-col gap-1 text-body-13 text-ink-2" data-testid="sandbox-network">
          <span>The internet and local services, over HTTP and HTTPS.</span>
          {'deniedPorts' in network ? (
            <span className="text-ink-3">
              Refused: Nodal&apos;s own ports{' '}
              {network.deniedPorts.map((p) => (
                <MonoCode key={p} className="mr-1">
                  {p}
                </MonoCode>
              ))}
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-2 text-warn">
              Nodal&apos;s ports are unknown, so the sandbox cannot refuse them.
              <MonoCode>{network.code}</MonoCode>
            </span>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOff}
        title="Turn the sandbox off?"
        message="Commands of this workspace will run without confinement from the next one on: they can write anywhere your account can, and read Nodal's data. Commands already running are not touched."
        confirmLabel="Turn off"
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
          title={broadFolderWords(broad.kind, broad.path).title}
          message={broadFolderWords(broad.kind, broad.path).message}
          confirmLabel="Allow"
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
