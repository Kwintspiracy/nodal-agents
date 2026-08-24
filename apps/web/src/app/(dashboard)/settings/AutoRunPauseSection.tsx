'use client';

/**
 * AutoRunPauseSection — le FREIN D'URGENCE de l'auto-exécution (0082,
 * inversion du modèle à deux clés, décision Quentin 24/08).
 *
 * Remplace LanCommandYoloSection, qui était une pré-condition d'activation
 * (« déverrouiller avant d'avoir le droit d'activer le Yolo par agent ») —
 * redondante, les deux gestes étant owner-only, et source d'un malentendu
 * complet. Ne reste que ce qui avait de la valeur : le coupe-circuit.
 *
 * Sémantique : par défaut INACTIF (rien n'est freiné, les toggles par agent
 * s'appliquent). Enclenché : toutes les règles auto_approve des outils
 * d'exécution de code deviennent dormantes — le runner les déshabille à
 * l'exécution (8b d'execute.ts, la frontière autoritaire) — sans être
 * supprimées. Le relâcher les ré-arme telles quelles, d'où la confirmation
 * AU RELÂCHEMENT (c'est la direction qui rend des pouvoirs), jamais à
 * l'enclenchement (freiner est toujours sûr).
 *
 * Visible dans TOUS les modes d'auth : un bouton rouge qui ne marche qu'en
 * LAN n'est pas un bouton rouge.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setAutoRunPauseAction, type AutoRunPauseView } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Banner from '@/components/ui/Banner';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import Switch from '@/components/ui/Switch';

interface Props {
  initial: AutoRunPauseView;
}

export default function AutoRunPauseSection({ initial }: Props) {
  const [paused, setPaused] = useState(initial.autoRunPaused);
  const [confirmResume, setConfirmResume] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    if (paused) {
      // Relâcher le frein ré-arme les règles Yolo existantes → confirmation.
      setConfirmResume(true);
    } else {
      // Freiner est toujours la direction sûre : aucun dialogue.
      doSet(true);
    }
  }

  function doSet(next: boolean) {
    setPaused(next);
    startTransition(async () => {
      const r = await setAutoRunPauseAction({ paused: next });
      if (!r.ok) {
        toast.error(r.message);
        setPaused(!next);
      } else {
        toast.success(
          next
            ? 'Auto-run paused. Every command, script and coding task asks for approval again.'
            : 'Auto-run resumed. Per-agent Yolo toggles apply again.',
        );
      }
    });
  }

  const isDisabled = !initial.isOwner || isPending;

  return (
    <div className="flex items-start gap-4 rounded-xl border border-rule-2 bg-paper px-[18px] py-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-medium-14 text-ink">Pause all auto-run</span>
          <MonoMicroTag tone="err">owner only</MonoMicroTag>
        </div>
        <p className="mt-1 text-body-13 leading-[1.4]! text-ink-3">
          The emergency brake. When on, every shell command, skill script and coding CLI task in
          this workspace asks for approval again — per-agent Yolo toggles are put to sleep, not
          deleted. Release the brake and they apply again as before.
        </p>

        {!initial.isOwner && (
          <p className="mt-2 text-body-12 text-ink-4">
            Only the workspace owner can change this setting.
          </p>
        )}

        {paused && initial.isOwner && (
          <Banner variant="warn">
            <span>
              <b className="block font-medium text-ink">Auto-run is paused workspace-wide</b>
              Nothing runs without your approval right now, whatever the per-agent toggles say.
              Release the brake to re-arm them.
            </span>
          </Banner>
        )}
      </div>

      {/* Toggle */}
      <div className="mt-0.5">
        <Switch
          checked={paused}
          onChange={handleToggle}
          disabled={isDisabled}
          trackClassName={paused ? 'border-err/40 bg-err/20' : 'border-rule-2 bg-canvas'}
          thumbClassName={paused ? 'translate-x-[18px] bg-err' : 'translate-x-[2px] bg-ink-3'}
        />
      </div>

      <ConfirmDialog
        open={confirmResume}
        title="Release the brake?"
        message="Per-agent Yolo rules re-arm exactly as they were: agents whose toggle is on will run shell commands and coding tasks again without approval."
        confirmLabel="Release"
        destructive
        onConfirm={() => {
          setConfirmResume(false);
          doSet(false);
        }}
        onCancel={() => setConfirmResume(false)}
      />
    </div>
  );
}
