'use client';

/**
 * VerificationSurfacesSection — quelles façons de travailler sont VÉRIFIÉES
 * (D8, plan « Vérifier & Corriger », T23).
 *
 * Une case par surface : l'outil de code, les agents Claude Code / Codex, les
 * outils fichiers, les commandes. Cochée = les travaux venant de cette surface
 * déclarent ce qu'ils modifient et sont prouvés par les commandes de preuve du
 * projet. Décochée = rien n'est prouvé pour cette surface, et chaque run le
 * dit (« surface hors vérification »). Toutes cochées par défaut.
 *
 * LE CONFIRMDIALOG VA SUR LE DÉCOCHAGE, jamais sur le recochage — l'INVERSE
 * exact du frein d'urgence (AutoRunPauseSection), qui confirme au RELÂCHEMENT
 * parce que c'est la direction qui rend des pouvoirs. Ici, décocher retire une
 * garantie ; recocher est toujours la direction sûre. Même principe, direction
 * opposée : ne pas « corriger » l'asymétrie.
 *
 * L'objet complet (les quatre clés) part à chaque sauvegarde — jamais un merge
 * partiel, pour qu'« absent » garde un seul sens.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { VerificationSurfaceKey, VerificationSurfaces } from '@nodal-agents/shared';
import { setVerificationSurfacesAction, type VerificationSurfacesView } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Checkbox from '@/components/ui/Checkbox';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';

const SURFACES: ReadonlyArray<{ key: VerificationSurfaceKey; label: string; hint: string }> = [
  { key: 'codeTask', label: 'Coding tool', hint: 'code_task: a coding CLI called as a tool' },
  {
    key: 'cliRuntime',
    label: 'Claude Code / Codex agents',
    hint: 'agents that ARE a coding CLI session',
  },
  { key: 'fileOps', label: 'File tools', hint: 'file_write, file_edit' },
  { key: 'shell', label: 'Commands and scripts', hint: 'run_command, run_skill_script' },
];

interface Props {
  initial: VerificationSurfacesView;
}

export default function VerificationSurfacesSection({ initial }: Props) {
  const [surfaces, setSurfaces] = useState<VerificationSurfaces>(initial.surfaces);
  const [pendingUncheck, setPendingUncheck] = useState<VerificationSurfaceKey | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(key: VerificationSurfaceKey, checked: boolean) {
    if (!checked) {
      // Décocher retire une garantie : confirmation.
      setPendingUncheck(key);
      return;
    }
    // Recocher est toujours la direction sûre : aucun dialogue.
    doSet({ ...surfaces, [key]: true });
  }

  function doSet(next: VerificationSurfaces) {
    const previous = surfaces;
    setSurfaces(next);
    startTransition(async () => {
      const r = await setVerificationSurfacesAction(next);
      if (!r.ok) {
        toast.error(r.message);
        setSurfaces(previous);
      } else {
        toast.success('Verification surfaces saved.');
      }
    });
  }

  const isDisabled = !initial.isOwner || isPending;
  const pendingLabel = SURFACES.find((s) => s.key === pendingUncheck)?.label ?? '';

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-rule-2 bg-paper px-[18px] py-4">
      <div className="flex items-center gap-2">
        <span className="text-medium-14 text-ink">What gets verified</span>
        <MonoMicroTag tone="err">owner only</MonoMicroTag>
      </div>
      <p className="text-body-13 leading-[1.4]! text-ink-3">
        A checked surface declares what it changes and gets proven by the project&apos;s proof
        commands. An unchecked one is not verified, and every run says so. All on by default.
      </p>

      <ul className="flex flex-col gap-2">
        {SURFACES.map((s) => (
          <li key={s.key} className="flex items-baseline gap-2">
            <Checkbox
              tone="ink"
              label={s.label}
              checked={surfaces[s.key]}
              disabled={isDisabled}
              onChange={(e) => handleChange(s.key, e.currentTarget.checked)}
              data-testid={`verification-surface-${s.key}`}
            />
            <span className="text-body-12 text-ink-4">{s.hint}</span>
          </li>
        ))}
      </ul>

      {!initial.isOwner && (
        <p className="text-body-12 text-ink-4">Only the workspace owner can change this setting.</p>
      )}

      <ConfirmDialog
        open={pendingUncheck !== null}
        title={`Stop verifying ${pendingLabel}?`}
        message="Work coming from this surface will no longer be proven by the project's proof commands. Each run will say it was not verified."
        confirmLabel="Stop verifying"
        destructive
        onConfirm={() => {
          const key = pendingUncheck;
          setPendingUncheck(null);
          if (key) doSet({ ...surfaces, [key]: false });
        }}
        onCancel={() => setPendingUncheck(null)}
      />
    </div>
  );
}
