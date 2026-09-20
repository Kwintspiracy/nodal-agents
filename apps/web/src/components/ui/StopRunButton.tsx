'use client';

// StopRunButton — ARRÊTER CE QUI TOURNE, depuis l'endroit où on le regarde
// (#252, 20/09/2026).
//
// Le geste existait déjà, mais sur UN écran : `jobs/CancelJobButton`, rendu par
// `/jobs/[id]` et nulle part ailleurs. Or personne ne regarde un run depuis
// `/jobs/[id]` : on le suit depuis sa page (`/runs`, `/scheduled`), depuis le
// fil où on lui a parlé, ou depuis la page d'une session de code. Sur ces
// trois-là, rien ne l'arrêtait — il fallait deviner l'adresse d'une quatrième
// page pour reprendre la main.
//
// Ce bouton est donc LE geste, et il n'y en a qu'un. `CancelJobButton` a
// disparu avec cette PR ; deux boutons d'arrêt auraient fini par confirmer deux
// choses différentes.
//
// ⚠️ CE QU'ARRÊTER VEUT DIRE, ET CE QUE ÇA NE VEUT PAS DIRE. `cancelJobAction`
// passe le job de tête ET tous ses délégués non terminés à `cancelled`, expire
// les approbations qui pendaient et coupe les tâches détachées du tableau. Le
// runner, lui, LIT ce statut au début de chaque tour (`execute.ts`, « Leg 2 ») :
// l'appel LLM en vol se termine normalement, et la boucle rend la main au
// contrôle suivant. Ce n'est pas un `kill`, et le texte de la confirmation le
// dit plutôt que de promettre un arrêt net qui n'existe pas (invariant #4).
//
// Un harnais externe lancé depuis la CLI (Claude Code, Codex) n'est pas tué non
// plus : le run est annulé du côté de Nodal, et c'est tout ce que ce bouton
// promet (hors périmètre de #252).
//
// ⚠️ IL SE CACHE TOUT SEUL. Le statut lui est donné, et il ne se dessine que
// tant que le travail est vivant. La règle est écrite une fois, dans
// `lib/job-live.ts` — hors de ce fichier, parce que les pages qui décident de
// dessiner une rangée d'actions sont des composants SERVEUR et ne peuvent pas
// appeler une fonction d'un module client (les trois ont rendu 500 le jour où
// elle vivait ici).

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from './RowActionButton';
import { cancelJobAction } from '@/lib/actions.ts';
import { canStopRun } from '@/lib/job-live.ts';

export default function StopRunButton({
  jobId,
  status,
}: {
  /** Le job de TÊTE à arrêter. Ses délégués suivent, l'action s'en charge. */
  jobId: string;
  /** Le statut de ce job. Rien n'est dessiné hors d'un statut vivant. */
  status: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  if (!canStopRun(status)) return null;

  function handleConfirm() {
    setOpen(false);
    startTransition(async () => {
      const r = await cancelJobAction(jobId);
      if (!r.ok) {
        // L'échec se DIT. Un bouton qui ne répond rien laisse croire que le run
        // s'arrête, et la page se rafraîchira sans rien changer.
        toast.error(r.message);
        return;
      }
      toast.success('Run stopped');
      // La page est rendue par le serveur : sans ce rafraîchissement, la
      // pastille d'état et ce bouton resteraient sur l'état d'avant le clic.
      router.refresh();
    });
  }

  return (
    <>
      {/* L'étiquette de test est sur l'enveloppe : `RowActionButton` a une
          liste de propriétés fermée, et lui en ouvrir une pour un test
          l'ouvrirait pour tout le reste. */}
      <span data-testid="stop-run">
        <RowActionButton tone="danger" onClick={() => setOpen(true)} disabled={isPending}>
          {isPending ? 'Stopping…' : 'Stop'}
        </RowActionButton>
      </span>
      <ConfirmDialog
        open={open}
        title="Stop this run?"
        // CE QUI VA SE PASSER, en toutes lettres : l'arrêt est coopératif, et
        // promettre mieux ferait passer les quelques secondes qui suivent pour
        // une panne.
        message="The run and everything it delegated stop at the next check. A model call already in flight finishes on its own, and the thread says the run was stopped."
        confirmLabel="Stop run"
        cancelLabel="Keep running"
        destructive
        onConfirm={handleConfirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
